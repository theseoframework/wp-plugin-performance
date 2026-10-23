"""Reconcile raw timings, CSV statistics, round budgets and XLSX types independently."""
import csv
import hashlib
import json
import math
import re
import statistics
import sys
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from xml.etree import ElementTree as ET

root = Path(sys.argv[1]).resolve()
(root / "verification.json").write_text(json.dumps({"verified": False, "status": "not_complete"}) + "\n", encoding="utf-8")
results = json.loads((root / "results.json").read_text(encoding="utf-8"))
assert results["summaries"] and results["blocks"], "No recorded benchmark checkpoints"
config = results["manifest"]["config"]
identities = config.get("candidates") or results["manifest"].get("candidates")
assert identities and all(item.get("slug") and item.get("mainFile") for item in identities), "Explicit plugin identity is required"
assert len({(item["slug"], item["mainFile"]) for item in identities}) == 1, "Cross-plugin reports are unsupported"
assert all("rank" not in row for row in results["summaries"]), "Ranking fields are no longer supported"
serialized_summaries = [dict(row) for row in results["summaries"]]
legacy_control_files = "controls" not in results and "fairness" in results
if "fairness" in config:
    assert "comparisonMode" not in config or config["comparisonMode"] == config["fairness"]
    config["comparisonMode"] = config.pop("fairness")
if "fairness" in results:
    assert "controls" not in results or results["controls"] == results["fairness"]
    results["controls"] = results.pop("fairness")
for row in results["summaries"]:
    for old, new in [("fairnessMode", "comparisonMode"), ("fairnessComplete", "controlsComplete"), ("fairnessAssessment", "controlAssessment")]:
        if old in row:
            assert new not in row or row[new] == row[old]
            row[new] = row.pop(old)
assert not results["manifest"]["failures"], results["manifest"]["failures"]
assert not any(block.get("error") for block in results["blocks"])
groups = defaultdict(list)
round_values = defaultdict(list)
phases = Counter()
rounds = Counter()
warmup_counts = Counter()
tokens = set()
raw_samples = []
for line in (root / "samples.ndjson").open(encoding="utf-8"):
    row = json.loads(line)
    raw_samples.append(row)
    assert row["phase"] in {"warmup", "measure"}
    assert row["valid"], (row["candidate"], row["scenario"], row["reasons"])
    assert row["executionToken"] == row["responseToken"]
    assert row["executionToken"] not in tokens
    tokens.add(row["executionToken"])
    expected_user = "1" if row["scenario"] in {"dashboard", "posts-list", "pages-list", "post-editor", "page-editor", "editor-save"} else "0"
    assert str(row["userId"]) == expected_user
    phases[row["phase"]] += 1
    key = tuple(row[k] for k in ("candidate", "wp", "php", "scenario"))
    if row["phase"] == "warmup":
        warmup_counts[key] += 1
    if row["phase"] == "measure":
        key = (row["candidate"], row["wp"], row["php"], row["scenario"])
        groups[key].append(row["elapsedMs"])
        round_values[key + (row["round"],)].append(row["elapsedMs"])
        rounds[key + (row["round"],)] += 1

for summary in results["summaries"]:
    key = tuple(summary[k] for k in ("candidate", "wp", "php", "scenario"))
    values = groups[key]
    if summary["status"] == "unavailable":
        assert not values and summary["minimumMs"] is None
        continue
    assert summary["status"] in {"provisional", "valid"}, (key, summary["issues"])
    assert summary["attempted"] == summary["valid"] == len(values) == config["samples"]
    assert summary["invalid"] == 0
    assert warmup_counts[key] == config["warmups"] * config["rounds"]
    for round_index in range(config["rounds"]):
        expected = config["samples"] // config["rounds"] + (round_index < config["samples"] % config["rounds"])
        assert rounds[key + (round_index + 1,)] == expected
    assert math.isclose(summary["minimumMs"], min(values), abs_tol=1e-9)
    assert math.isclose(summary["medianMs"], statistics.median(values), abs_tol=1e-9)
    assert math.isclose(summary["meanMs"], statistics.mean(values), abs_tol=1e-8)
    cutoff = (1 + config["outlierFraction"]) * (statistics.median(values) if config["outlierReference"] == "median" else statistics.mean(values))
    kept = [value for value in values if value <= cutoff]
    assert summary["highOutliers"] == len(values) - len(kept)
    assert math.isclose(summary["trimmedMeanMs"], statistics.mean(kept), abs_tol=1e-8)

baseline_fields = ("baselineLeadingMs", "baselineDeltaMs", "baselineMedianMs", "baselineMedianDeltaMs", "baselineDeltaLowMs", "baselineDeltaHighMs", "baselineMedianDeltaLowMs", "baselineMedianDeltaHighMs")
negative_controls = [item["id"] for item in config.get("candidates", []) if item.get("negativeControl")]


def control_spread(summary, statistic):
    primary = summary["baselineCandidate"]
    differences = []
    for candidate in negative_controls:
        for index in range(config["rounds"]):
            repeat = round_values[(candidate, summary["wp"], summary["php"], summary["scenario"], index + 1)]
            control = round_values[(primary, summary["wp"], summary["php"], summary["scenario"], index + 1)]
            differences.append(abs(statistic(repeat) - statistic(control)))
    return max(differences)


if results.get("reportVersion", 0) >= 2:
    for summary in results["summaries"]:
        controls = [item for item in results["summaries"] if item["baseline"] and item["eligible"] and item["cohort"] == summary["cohort"] and (not config.get("baselineCandidate") or item["candidate"] == config["baselineCandidate"])]
        if not summary["eligible"] or summary["scenario"] in {"sitemap", "redirect"} or len(controls) != 1:
            assert all(summary[field] is None for field in baseline_fields)
            assert not summary["baselineCandidate"] and summary["baselineReason"]
            continue
        control = controls[0]
        assert summary["baselineCandidate"] == control["candidate"]
        own_key = tuple(summary[k] for k in ("candidate", "wp", "php", "scenario"))
        core_key = tuple(control[k] for k in ("candidate", "wp", "php", "scenario"))
        for stat, base, delta, low, high in [(min, "baselineLeadingMs", "baselineDeltaMs", "baselineDeltaLowMs", "baselineDeltaHighMs"), (statistics.median, "baselineMedianMs", "baselineMedianDeltaMs", "baselineMedianDeltaLowMs", "baselineMedianDeltaHighMs")]:
            own = stat(groups[own_key])
            core = stat(groups[core_key])
            assert math.isclose(summary[base], core, abs_tol=1e-9)
            assert math.isclose(summary[delta], own - core, abs_tol=1e-9)
            own_rounds = [stat(round_values[own_key + (index + 1,)]) for index in range(config["rounds"])]
            core_rounds = [stat(round_values[core_key + (index + 1,)]) for index in range(config["rounds"])]
            spread = control_spread(summary, stat) if config.get("comparisonMode") == "repeat-controls" and summary.get("controlsComplete") else 0
            assert math.isclose(summary[low], min(own_rounds) - max(core_rounds) - spread, abs_tol=1e-9)
            assert math.isclose(summary[high], max(own_rounds) - min(core_rounds) + spread, abs_tol=1e-9)
    html = (root / "report.html").read_text(encoding="utf-8")
    embedded = json.loads(re.search(r'<script id="benchmark-data" type="application/json">(.*?)</script>', html, re.S).group(1))
    assert embedded["summaries"] == serialized_summaries
    assert embedded["samples"] == config["samples"] and embedded["rounds"] == config["rounds"]
    assert not re.search(r'<script[^>]+src=', html, re.I)

if results.get("reportVersion", 0) >= 4:
    comparison = results["outputComparison"]
    assert comparison == embedded["outputComparison"]
    assert comparison == json.loads((root / "output-comparison.json").read_text(encoding="utf-8"))
    expected = {(r["candidate"], r["cohort"]) for r in results["summaries"] if r["scenario"] in comparison["htmlScenarios"]}
    actual = [(r["candidate"], r["cohort"]) for r in comparison["records"]]
    assert len(actual) == len(set(actual)) and set(actual) == expected
    by_token = {r["executionToken"]: r for r in raw_samples}

    class OutputReader(HTMLParser):
        def __init__(self):
            super().__init__()
            self.head = False
            self.inert = 0
            self.script = None
            self.scripts = []

        def handle_starttag(self, tag, attrs):
            attrs = dict(attrs)
            if tag == "head":
                self.head = True
            if tag in {"template", "noscript"}:
                self.inert += 1
            if tag == "script" and not self.inert and attrs.get("type", "").split(";")[0].lower() == "application/ld+json":
                self.script = {"location": "head" if self.head else "body/footer", "text": ""}

        def handle_data(self, data):
            if self.script is not None:
                self.script["text"] += data

        def handle_endtag(self, tag):
            if tag == "head":
                self.head = False
            if tag in {"template", "noscript"}:
                self.inert = max(0, self.inert - 1)
            if tag == "script" and self.script is not None:
                self.scripts.append(self.script)
                self.script = None

    for record in comparison["records"]:
        assert record["status"] in {"available", "unavailable"}
        if record["status"] == "unavailable":
            assert record["reason"] and record["cells"] == {}
            continue
        assert re.fullmatch(r"[a-zA-Z0-9-]+\.fastest\.json", record["source"])
        response = json.loads((root / record["source"]).read_text(encoding="utf-8"))
        assert hashlib.sha256(response["body"].encode()).hexdigest() == response["sha256"] == record["sha256"]
        raw = by_token[response["executionToken"]]
        assert raw["phase"] == "measure" and raw["valid"] and str(raw["userId"]) == str(response["userId"]) == "0"
        assert raw["executionToken"] == raw["responseToken"] and raw["sha256"] == record["sha256"]
        for field in ("candidate", "round", "scenario", "wp", "php", "blockId"):
            assert raw[field] == record[field]
        assert raw["route"] == record["route"] == response["route"]
        assert raw["status"] == record["responseStatus"] == response["status"]
        assert raw["contentType"] == response["contentType"] and response["contentType"].lower().startswith("text/html")
        assert raw["elapsedMs"] == record["elapsedMs"] == response["elapsedMs"]
        summary = next(r for r in results["summaries"] if r["candidate"] == record["candidate"] and r["cohort"] == record["cohort"])
        assert summary["eligible"] and summary["minimumMs"] == record["elapsedMs"]
        assert all(tag["raw"] in response["body"] for tag in record["tags"])
        assert all(script["raw"] in response["body"] for script in record["schemas"])
        reader = OutputReader()
        reader.feed(response["body"])
        assert len(reader.scripts) == len(record["schemas"])
        for captured, script in zip(reader.scripts, record["schemas"]):
            assert captured["location"] == script["location"]
            if "error" not in script:
                assert json.loads(captured["text"]) == script["json"]
        assert record["cells"]["tags.count"] == len(record["tags"])
        assert record["cells"]["jsonld.count"] == len(record["schemas"])
        assert record["cells"]["jsonld.errors"] == len(record["errors"])
    with (root / "output-comparison.csv").open(encoding="utf-8-sig", newline="") as stream:
        output_rows = list(csv.DictReader(stream))
    assert len(output_rows) == len(comparison["records"]) * len(comparison["features"])
    for record in comparison["records"]:
        cells = [row for row in output_rows if row["candidate"] == record["candidate"] and row["cohort"] == record["cohort"]]
        assert len(cells) == len(comparison["features"])
        for feature, cell in zip(comparison["features"], cells):
            expected_value = record["cells"][feature["id"]] if record["status"] == "available" else "Unavailable"
            expected_value = str(expected_value)
            if isinstance(record["cells"].get(feature["id"]), str) and re.match(r"[=+\-@\t\r]", expected_value):
                expected_value = "'" + expected_value
            assert cell["feature"] == feature["id"] and cell["value"] == expected_value and cell["status"] == record["status"]

if config.get("comparisonMode") == "repeat-controls":
    checkpoints = [json.loads(line) for line in (root / "blocks.ndjson").open(encoding="utf-8") if line.strip()]
    assert checkpoints == results["blocks"], "Reported blocks differ from saved measurement checkpoints"
    candidate_ids = [item["id"] for item in config["candidates"]]
    assert negative_controls and config["rounds"] % len(candidate_ids) == 0
    assert config["samples"] % config["rounds"] == 0
    primary_package = next(item for item in results["manifest"]["candidates"] if item["id"] == config["baselineCandidate"])
    assert primary_package["baseline"] and not primary_package.get("negativeControl")
    identity_fields = ("slug", "mainFile", "version", "archiveSha256", "mainFileSha256", "phpSourceSha256", "mounts")
    for candidate in results["manifest"]["candidates"]:
        if candidate["id"] in negative_controls:
            assert candidate["baseline"]
            assert all(candidate.get(field) == primary_package.get(field) for field in identity_fields)
            assert candidate.get("extraPlugins", []) == primary_package.get("extraPlugins", [])
    runtimes = {(block["wp"], block["php"]) for block in results["blocks"]}
    for wp_version, php_version in runtimes:
        for index in range(config["rounds"]):
            order = []
            for block in results["blocks"]:
                if (block["wp"], block["php"], block["round"]) == (wp_version, php_version, index + 1) and (not order or order[-1] != block["candidate"]):
                    order.append(block["candidate"])
            offset = index % len(candidate_ids)
            assert order == candidate_ids[offset:] + candidate_ids[:offset], order
    completed = []
    for summary in results["summaries"]:
        assert summary["comparisonMode"] == "repeat-controls"
        assert summary["negativeControl"] == (summary["candidate"] in negative_controls)
        controls = [next((item for item in results["summaries"] if item["candidate"] == candidate and item["cohort"] == summary["cohort"]), None) for candidate in [config["baselineCandidate"]] + negative_controls]
        complete = bool(summary["baselineCandidate"]) and all(item and item["eligible"] and item["status"] == "valid" and item["roundCount"] == config["rounds"] and len(item.get("roundMetrics", [])) == config["rounds"] and {record["round"] for record in item["roundMetrics"]} == set(range(1, config["rounds"] + 1)) for item in [summary] + controls)
        assert summary["controlsComplete"] == complete
        if not complete:
            assert summary["controlMinimumSpreadMs"] is None and summary["controlMedianSpreadMs"] is None
            continue
        for round_record in summary["roundMetrics"]:
            values = round_values[(summary["candidate"], summary["wp"], summary["php"], summary["scenario"], round_record["round"])]
            assert round_record["valid"] == len(values) == config["samples"] // config["rounds"]
            assert math.isclose(round_record["minimumMs"], min(values), abs_tol=1e-9)
            assert math.isclose(round_record["medianMs"], statistics.median(values), abs_tol=1e-9)
        for statistic, field in [(min, "controlMinimumSpreadMs"), (statistics.median, "controlMedianSpreadMs")]:
            assert math.isclose(summary[field], control_spread(summary, statistic), abs_tol=1e-9)
        if not summary["baseline"]:
            expected = "Lower" if summary["baselineDeltaHighMs"] < 0 and summary["baselineMedianDeltaHighMs"] < 0 else ("Higher" if summary["baselineDeltaLowMs"] > 0 and summary["baselineMedianDeltaLowMs"] > 0 else "Unresolved")
            assert summary["controlAssessment"].startswith(expected)
        completed.append(summary)
    assert len(results["controls"]) == len(completed)
    control_stem = "fairness" if legacy_control_files else "controls"
    assert json.loads((root / f"{control_stem}.json").read_text(encoding="utf-8")) == results["controls"]
    with (root / f"{control_stem}.csv").open(encoding="utf-8-sig", newline="") as handle:
        controls_csv = list(csv.DictReader(handle))
    assert len(controls_csv) == len(completed)
    assert {(item["candidate"], item["cohort"]) for item in results["controls"]} == {(item["candidate"], item["cohort"]) for item in completed}
    for row, evidence in zip(controls_csv, results["controls"]):
        summary = next(item for item in completed if item["candidate"] == evidence["candidate"] and item["cohort"] == evidence["cohort"])
        for field in ("candidate", "wp", "php", "scenario", "cohort"):
            assert row[field] == evidence[field] == summary[field]
        assert row["primaryControl"] == evidence["primaryControl"] == config["baselineCandidate"]
        assert row["negativeControls"] == evidence["negativeControls"] == "; ".join(negative_controls)
        assert row["assessment"] == evidence["assessment"] == summary["controlAssessment"]
        for field in ("controlMinimumSpreadMs", "controlMedianSpreadMs", "minimumDeltaMs", "minimumLowMs", "minimumHighMs", "medianDeltaMs", "medianLowMs", "medianHighMs"):
            assert math.isclose(float(row[field]), evidence[field], abs_tol=1e-9)
        for field, source in [("controlMinimumSpreadMs", "controlMinimumSpreadMs"), ("controlMedianSpreadMs", "controlMedianSpreadMs"), ("minimumDeltaMs", "baselineDeltaMs"), ("minimumLowMs", "baselineDeltaLowMs"), ("minimumHighMs", "baselineDeltaHighMs"), ("medianDeltaMs", "baselineMedianDeltaMs"), ("medianLowMs", "baselineMedianDeltaLowMs"), ("medianHighMs", "baselineMedianDeltaHighMs")]:
            assert math.isclose(evidence[field], summary[source], abs_tol=1e-9)
        expected_differences = []
        for candidate in negative_controls:
            for index in range(1, config["rounds"] + 1):
                repeat_values = round_values[(candidate, summary["wp"], summary["php"], summary["scenario"], index)]
                primary_values = round_values[(config["baselineCandidate"], summary["wp"], summary["php"], summary["scenario"], index)]
                expected_differences.append({"candidate": candidate, "round": index, "minimumMs": min(repeat_values) - min(primary_values), "medianMs": statistics.median(repeat_values) - statistics.median(primary_values)})
        assert len(evidence["controlDifferences"]) == len(expected_differences)
        for actual, expected in zip(evidence["controlDifferences"], expected_differences):
            assert actual["candidate"] == expected["candidate"] and actual["round"] == expected["round"]
            assert math.isclose(actual["minimumMs"], expected["minimumMs"], abs_tol=1e-9)
            assert math.isclose(actual["medianMs"], expected["medianMs"], abs_tol=1e-9)

if results.get("reportVersion", 0) >= 3:
    definitions = {
        "front-end": ["home-blog", "home-static", "blog-page", "post", "page", "category", "tag", "search", "404"],
        "back-end": ["dashboard", "posts-list", "pages-list", "post-editor", "page-editor"],
        "saving": ["editor-save"],
    }
    deferred = {item["candidate"] for item in results["manifest"].get("exclusions", []) if not item.get("scenario")}
    participants = [item["id"] for item in results["manifest"]["candidates"] if item["id"] not in deferred]
    runtime_groups = {item["runtimeGroup"] for item in results["summaries"] if len(json.loads(item["runtimeGroup"])) > 2}
    assert len(results["groupSummaries"]) == len(runtime_groups) * len(definitions) * len(participants)
    group_numeric_fields = ["scenarioCount", "requestedScenarioCount", "measuredCalls", "attemptedCalls", "warmupCalls", "saveCalls", "averageLeadingMs", "averageMedianMs", "averageRequestMs", "baselineLeadingMs", "baselineMedianMs", "baselineRequestMs", "baselineDeltaMs", "baselineMedianDeltaMs", "baselineRequestDeltaMs"]
    for row in results["groupSummaries"]:
        runtime_rows = [item for item in results["summaries"] if item["runtimeGroup"] == row["runtimeGroup"]]
        planned = [scenario for scenario in definitions[row["group"]] if not isinstance(config.get("scenarios"), list) or scenario in config["scenarios"]]
        common = []
        for scenario in planned:
            matches = [[item for item in runtime_rows if item["candidate"] == candidate and item["scenario"] == scenario] for candidate in participants]
            if matches and all(len(items) == 1 and items[0]["eligible"] for items in matches) and len({items[0]["cohort"] for items in matches}) == 1:
                common.append(scenario)
        assert row["scenarios"] == "; ".join(common)
        assert row["excludedScenarios"] == "; ".join(scenario for scenario in planned if scenario not in common)
        assert row["participants"] == "; ".join(participants)
        assert row["scenarioCount"] == len(common) and row["requestedScenarioCount"] == len(planned)
        assert row["eligible"] == bool(common)
        members = [next(item for item in runtime_rows if item["candidate"] == row["candidate"] and item["scenario"] == scenario) for scenario in common]
        assert row["memberCohorts"] == [item["cohort"] for item in members]
        keys = [(row["candidate"], row["wp"], row["php"], scenario) for scenario in common]
        measured = sum(len(groups[key]) for key in keys)
        assert row["measuredCalls"] == row["attemptedCalls"] == measured
        assert row["warmupCalls"] == sum(warmup_counts[key] for key in keys)
        assert row["saveCalls"] == (measured if row["group"] == "saving" else 0)
        if row["group"] == "back-end":
            assert "editor-save" not in common and row["saveCalls"] == 0
        for statistic, value_field, core_field, delta_field in [(min, "averageLeadingMs", "baselineLeadingMs", "baselineDeltaMs"), (statistics.median, "averageMedianMs", "baselineMedianMs", "baselineMedianDeltaMs"), (statistics.mean, "averageRequestMs", "baselineRequestMs", "baselineRequestDeltaMs")]:
            expected = statistics.mean(statistic(groups[key]) for key in keys) if keys else None
            if expected is None:
                assert row[value_field] is None and row[core_field] is None and row[delta_field] is None
            else:
                assert math.isclose(row[value_field], expected, abs_tol=1e-8)
                if row["baselineCandidate"]:
                    control_keys = [(row["baselineCandidate"], row["wp"], row["php"], scenario) for scenario in common]
                    core = statistics.mean(statistic(groups[key]) for key in control_keys)
                    assert all(item["baselineCandidate"] == row["baselineCandidate"] for item in members)
                    assert math.isclose(row[core_field], core, abs_tol=1e-8)
                    assert math.isclose(row[delta_field], expected - core, abs_tol=1e-8)
                else:
                    assert row[core_field] is None and row[delta_field] is None
    assert embedded["groupSummaries"] == results["groupSummaries"]
    with (root / "group-summary.csv").open(encoding="utf-8-sig", newline="") as handle:
        exported = list(csv.DictReader(handle))
    assert len(exported) == len(results["groupSummaries"])
    for row, expected in zip(exported, results["groupSummaries"]):
        assert (row["candidate"], row["group"], row["runtimeGroup"]) == (expected["candidate"], expected["group"], expected["runtimeGroup"])
        for field in group_numeric_fields:
            if expected[field] is None:
                assert row[field] == ""
            else:
                assert math.isclose(float(row[field]), expected[field], abs_tol=1e-8)

raw_block_records = [json.loads(line) for line in (root / "blocks.ndjson").open(encoding="utf-8") if line.strip()]
raw_blocks_by_id = {block["blockId"]: block for block in raw_block_records}
assert len(raw_blocks_by_id) == len(raw_block_records), "Duplicate raw block IDs"
samples_by_block = defaultdict(list)
for sample in raw_samples:
    samples_by_block[sample["blockId"]].append(sample)
durable_checkpoints = list(root.glob("*.checkpoint.json"))
for checkpoint_file in durable_checkpoints:
    checkpoint = json.loads(checkpoint_file.read_text(encoding="utf-8"))
    assert checkpoint["kind"] == "wp-performance-block-v1"
    block_id = checkpoint["block"]["blockId"]
    assert checkpoint_file.name == f"{block_id}.checkpoint.json"
    assert block_id in raw_blocks_by_id, f"Durable checkpoint missing from aggregate index: {block_id}"
    assert checkpoint["block"] == raw_blocks_by_id[block_id]
    assert checkpoint["samples"] == samples_by_block[block_id]

with (root / "samples.csv").open(encoding="utf-8-sig", newline="") as handle:
    sample_export = list(csv.DictReader(handle))
    assert len(sample_export) == len(raw_samples) == sum(phases.values())
    for row, source in zip(sample_export, raw_samples):
        for field, actual in row.items():
            expected = source.get(field)
            if isinstance(expected, (int, float)) and not isinstance(expected, bool):
                assert math.isclose(float(actual), expected, rel_tol=0, abs_tol=1e-9), (field, actual, expected)
            else:
                text = "" if expected is None else (str(expected).lower() if isinstance(expected, bool) else str(expected))
                if text.startswith(("=", "+", "-", "@", "\t", "\r")):
                    text = "'" + text
                assert actual == text, (field, actual, text)
with (root / "summary.csv").open(encoding="utf-8-sig", newline="") as handle:
    rows = list(csv.DictReader(handle))
    assert len(rows) == len(results["summaries"])
    for row, summary in zip(rows, results["summaries"]):
        assert row["candidate"] == summary["candidate"] and row["scenario"] == summary["scenario"]
        if summary["minimumMs"] is not None:
            assert float(row["minimumMs"]) == summary["minimumMs"]
        if results.get("reportVersion", 0) >= 2:
            for field in baseline_fields:
                if summary[field] is None:
                    assert row[field] == ""
                else:
                    assert math.isclose(float(row[field]), summary[field], abs_tol=1e-9)

with (root / "temperatures.csv").open(encoding="utf-8-sig", newline="") as handle:
    temperatures = list(csv.DictReader(handle))
    assert len(temperatures) == 2 * len(results["blocks"])
    for reading in temperatures:
        if not reading["celsius"]:
            assert reading["reason"]

load_readings = []
load_file = root / "cpu-load.csv"
if any(block.get("cpu") for block in results["blocks"]):
    assert load_file.exists(), "CPU interval CSV is missing"
if load_file.exists():
    with load_file.open(encoding="utf-8-sig", newline="") as handle:
        load_readings = list(csv.DictReader(handle))
    assert len(load_readings) == len(results["blocks"])
    for reading, block in zip(load_readings, results["blocks"]):
        assert reading["blockId"] == block["blockId"]
        if reading["percent"] == "":
            assert reading["reason"]
            continue
        percent = float(reading["percent"])
        assert 0 <= percent <= 100
        assert reading["scope"] == block["cpu"]["load"]["scope"]
        before, after = block["cpu"]["before"], block["cpu"]["after"]
        assert len(before["cpus"]) == len(after["cpus"]) == int(reading["logicalCPUs"])
        delta = Counter()
        for first, last in zip(before["cpus"], after["cpus"]):
            for key in ("user", "nice", "sys", "idle", "irq"):
                change = last["times"][key] - first["times"][key]
                assert change >= 0
                delta[key] += change
        total = sum(delta.values()) - (delta["irq"] if before["platform"] == "win32" else 0)
        assert total > 0
        assert math.isclose(percent, 100 * (total - delta["idle"]) / total, abs_tol=1e-9)
        assert float(reading["durationMs"]) == after["monotonicMs"] - before["monotonicMs"] > 0

def cache_assessment(before, after):
    value = {"status": "not-recorded", "hits": None, "misses": None, "probeFileBound": None, "jitCodeGrowthBytes": None}
    if not before or not after or "running" not in before or "running" not in after:
        return value
    if not before["running"] or not after["running"]:
        value["status"] = "file-cache-unobservable" if "1" in (before.get("fileOnly"), after.get("fileOnly")) else "inactive"
    elif any(before.get(key) is None or before.get(key) != after.get(key) for key in ("pid", "startTime", "lastRestartTime")):
        value["status"] = "instance-changed"
    elif any(not isinstance(before.get(key), (int, float)) or not isinstance(after.get(key), (int, float)) or after[key] < before[key] or (key.endswith("Restarts") and before[key] != after[key]) for key in ("hits", "misses", "oomRestarts", "hashRestarts", "manualRestarts")):
        value["status"] = "counter-reset"
    else:
        value["hits"], value["misses"] = after["hits"] - before["hits"], after["misses"] - before["misses"]
        bound = after.get("includedScripts")
        value["probeFileBound"] = bound if isinstance(bound, int) and bound >= 0 else None
        value["status"] = "observed-reuse" if value["probeFileBound"] is not None and value["hits"] > bound else "no-confirmed-reuse"
        first_jit, last_jit = before.get("jitStatus") or {}, after.get("jitStatus") or {}
        if first_jit.get("on") and last_jit.get("on") and all(isinstance(item, (int, float)) for item in (first_jit.get("buffer_free"), last_jit.get("buffer_free"))) and last_jit["buffer_free"] <= first_jit["buffer_free"]:
            value["jitCodeGrowthBytes"] = first_jit["buffer_free"] - last_jit["buffer_free"]
    return value


cache_readings = []
cache_file = root / "cache-reuse.csv"
if any(block.get("cacheBefore") for block in results["blocks"]):
    assert cache_file.exists(), "Cache observation CSV is missing"
if cache_file.exists():
    with cache_file.open(encoding="utf-8-sig", newline="") as handle:
        cache_readings = list(csv.DictReader(handle))
    assert len(cache_readings) == len(results["blocks"])
    for reading, block in zip(cache_readings, results["blocks"]):
        assert reading["blockId"] == block["blockId"]
        expected = cache_assessment(block.get("cacheBefore"), block.get("cacheAfter"))
        if "cacheBeforeWorkers" in block or "cacheAfterWorkers" in block:
            previous = {item["pid"]: item for item in block.get("cacheBeforeWorkers", []) if item and item.get("pid") is not None}
            following = {item["pid"]: item for item in reversed(block.get("cacheAfterWorkers", [])) if item and item.get("pid") is not None}
            ids = sorted(previous.keys() | following.keys())
            workers = [{"pid": pid, **cache_assessment(previous.get(pid), following.get(pid))} for pid in ids]
            matched = len(previous.keys() & following.keys())
            reuse = sum(item["status"] == "observed-reuse" for item in workers)
            statuses = {item["status"] for item in workers}
            complete = matched == len(ids) and matched >= config["workers"]
            status = "not-recorded" if not workers else (workers[0]["status"] if complete and len(statuses) == 1 else ("partial-reuse" if reuse else "incomplete-observation"))
            expected = {
                "status": status, "expectedWorkers": config["workers"], "observedWorkers": len(ids),
                "matchedWorkers": matched, "reuseWorkers": reuse, "workers": workers,
            }
            for field in ("hits", "misses", "probeFileBound", "jitCodeGrowthBytes"):
                expected[field] = sum(item[field] for item in workers) if workers and all(item[field] is not None for item in workers) else None
            assert reading["workerIds"] == "; ".join(map(str, ids))
        assert block["cacheReuse"] == expected
        for field, value in expected.items():
            if field == "workers":
                continue
            if value is None:
                assert reading[field] == ""
            elif isinstance(value, (int, float)):
                assert float(reading[field]) == value
            else:
                assert reading[field] == value


clock_readings = []
clock_file = root / "clocks.csv"
if any(block.get("clockBefore") or block.get("clockAfter") for block in results["blocks"]):
    assert clock_file.exists(), "Clock CSV is missing"
if clock_file.exists():
    with clock_file.open(encoding="utf-8-sig", newline="") as handle:
        clock_readings = list(csv.DictReader(handle))
    assert len(clock_readings) == 2 * len(results["blocks"])
    for index, reading in enumerate(clock_readings):
        block = results["blocks"][index // 2]
        assert reading["blockId"] == block["blockId"]
        assert reading["phase"] == ("before" if index % 2 == 0 else "after")
        clock = block.get("clockBefore" if index % 2 == 0 else "clockAfter")
        if reading["minimumMHz"] == "":
            assert reading["reason"] and reading["maximumMHz"] == ""
            continue
        sensors = json.loads(reading["sensors"])
        assert sensors == clock["sensors"] and reading["at"] == clock["at"]
        assert len({sensor["kind"] for sensor in sensors}) == 1
        assert all(math.isfinite(sensor["mhz"]) and sensor["mhz"] > 0 for sensor in sensors)
        assert float(reading["minimumMHz"]) == min(sensor["mhz"] for sensor in sensors)
        assert float(reading["maximumMHz"]) == max(sensor["mhz"] for sensor in sensors)
        for sensor in sensors:
            if sensor["kind"] == "os-performance-estimate":
                assert math.isclose(sensor["mhz"], sensor["referenceMHz"] * sensor["performancePercent"] / 100, rel_tol=0, abs_tol=1e-9)

workbook = root / "performance.xlsx"
xlsx_checked = False
if workbook.exists():
    namespace = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    with zipfile.ZipFile(workbook) as archive:
        structure = ET.fromstring(archive.read("xl/workbook.xml"))
        expected_sheets = ["Summary", "Samples", "CPU context", "Run information"] + (["Impact charts"] if results.get("reportVersion", 0) >= 2 else []) + (["Group averages"] if results.get("reportVersion", 0) >= 3 else []) + (["Repeat controls"] if config.get("comparisonMode") == "repeat-controls" else [])
        assert [sheet.attrib["name"] for sheet in structure.findall("m:sheets/m:sheet", namespace)] == expected_sheets
        summary = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))
        for index, row in enumerate(results["summaries"], start=2):
            cell = summary.find(f".//m:c[@r='H{index}']", namespace)
            if row["minimumMs"] is None:
                assert cell is None or cell.find("m:v", namespace) is None or not cell.find("m:v", namespace).text
            else:
                assert cell is not None and cell.attrib.get("t") not in {"s", "inlineStr", "str", "e"}
                value = float(cell.find("m:v", namespace).text)
                assert value > 0 and math.isclose(value, row["minimumMs"], abs_tol=1e-9)
        probe_sheet = ET.fromstring(archive.read("xl/worksheets/sheet3.xml"))
        shared = ET.fromstring(archive.read("xl/sharedStrings.xml")) if "xl/sharedStrings.xml" in archive.namelist() else []
        strings = ["".join(item.itertext()) for item in shared]
        columns = {}
        for cell in probe_sheet.find("m:sheetData/m:row", namespace):
            value = cell.find("m:v", namespace)
            if cell.attrib.get("t") == "s":
                label = strings[int(value.text)]
            elif cell.attrib.get("t") == "inlineStr":
                label = "".join(cell.itertext())
            else:
                label = value.text if value is not None else ""
            columns[label] = "".join(character for character in cell.attrib["r"] if character.isalpha())

        def check_date(cell, expected):
            assert cell is not None and cell.attrib.get("t") not in {"s", "inlineStr", "str"}
            instant = datetime.fromisoformat(expected.replace("Z", "+00:00"))
            serial = (instant - datetime(1899, 12, 30, tzinfo=timezone.utc)).total_seconds() / 86400
            value = cell.find("m:v", namespace).text
            if cell.attrib.get("t") == "d":
                stored = datetime.fromisoformat(value.replace("Z", "+00:00"))
                if stored.tzinfo is None:
                    stored = stored.replace(tzinfo=timezone.utc)
                # Excel serial conversion can round a native Date by one millisecond.
                assert abs((stored - instant).total_seconds()) <= 0.001
            else:
                assert math.isclose(float(value), serial, rel_tol=0, abs_tol=1e-8)

        if results.get("reportVersion", 0) >= 3:
            sample_sheet = ET.fromstring(archive.read("xl/worksheets/sheet2.xml"))
            sample_cells = {cell.attrib["r"]: cell for cell in sample_sheet.findall("m:sheetData/m:row/m:c", namespace)}

            def text_value(cell):
                if cell is None:
                    return ""
                if cell.attrib.get("t") == "inlineStr":
                    return "".join(cell.find("m:is", namespace).itertext())
                value = cell.find("m:v", namespace)
                if value is None:
                    return ""
                return strings[int(value.text)] if cell.attrib.get("t") == "s" else value.text

            for index, source in enumerate(raw_samples, start=2):
                for column, field in [("E", "round"), ("G", "sequence"), ("H", "elapsedMs"), ("I", "ttfbMs"), ("J", "status"), ("K", "bytes")]:
                    cell = sample_cells.get(f"{column}{index}")
                    assert cell is not None and cell.attrib.get("t") not in {"s", "inlineStr", "str", "e", "b", "d"}
                    assert math.isclose(float(cell.find("m:v", namespace).text), source[field], rel_tol=0, abs_tol=1e-9)
                for column, field in [("A", "candidate"), ("B", "scenario"), ("C", "wp"), ("D", "php"), ("F", "phase"), ("M", "reasons"), ("N", "pluginVersion"), ("P", "blockId"), ("Q", "sha256"), ("R", "route"), ("S", "userId"), ("T", "contentType"), ("U", "location"), ("V", "executionToken"), ("W", "responseToken")]:
                    assert text_value(sample_cells.get(f"{column}{index}")) == str(source.get(field) or "")
                boolean = sample_cells.get(f"L{index}")
                assert boolean is not None and boolean.attrib.get("t") == "b" and boolean.find("m:v", namespace).text == ("1" if source["valid"] else "0")
                check_date(sample_cells.get(f"O{index}"), source["at"])
            run_information = ET.fromstring(archive.read("xl/worksheets/sheet4.xml"))
            for address, expected in [("B4", results["manifest"]["startedAt"]), ("B5", results["manifest"]["finishedAt"])]:
                check_date(run_information.find(f".//m:c[@r='{address}']", namespace), expected)

        for index, reading in enumerate(temperatures):
            if reading["at"]:
                cell = probe_sheet.find(f".//m:c[@r='{columns['Reading time (UTC)']}{index + 2}']", namespace)
                check_date(cell, reading["at"])
        if load_readings:
            for index, reading in enumerate(load_readings):
                if reading["percent"] == "":
                    continue
                cell = probe_sheet.find(f".//m:c[@r='{columns['Block CPU busy (%)']}{3 + 2 * index}']", namespace)
                assert cell is not None and cell.attrib.get("t") not in {"s", "inlineStr", "str"}
                assert math.isclose(float(cell.find("m:v", namespace).text), float(reading["percent"]), abs_tol=1e-9)
        for index, reading in enumerate(clock_readings):
            if reading["at"]:
                cell = probe_sheet.find(f".//m:c[@r='{columns['Clock query time (UTC)']}{index + 2}']", namespace)
                check_date(cell, reading["at"])
            for field, title in [("minimumMHz", "Clock minimum (MHz)"), ("maximumMHz", "Clock maximum (MHz)")]:
                if reading[field] != "":
                    cell = probe_sheet.find(f".//m:c[@r='{columns[title]}{index + 2}']", namespace)
                    assert cell is not None and cell.attrib.get("t") not in {"s", "inlineStr", "str", "d"}
                    assert math.isclose(float(cell.find("m:v", namespace).text), float(reading[field]), rel_tol=0, abs_tol=1e-9)
        for sheet, expected in [(1, len(results["summaries"]) + 1), (2, sum(phases.values()) + 1), (3, len(temperatures) + 1)]:
            with archive.open(f"xl/worksheets/sheet{sheet}.xml") as handle:
                count = 0
                for event, element in ET.iterparse(handle, events=("end",)):
                    if element.tag.endswith("}row"):
                        count += 1
                        element.clear()
                assert count == expected, (sheet, count, expected)
        styles = ET.fromstring(archive.read("xl/styles.xml"))
        assert any(item.attrib.get("formatCode") == "yyyy-mm-dd hh:mm:ss" for item in styles.findall(".//m:numFmt", namespace))
        if results.get("reportVersion", 0) >= 2:
            for index, row in enumerate(results["summaries"], start=2):
                for field, column in [("baselineLeadingMs", "Q"), ("baselineDeltaMs", "R"), ("baselineMedianMs", "S"), ("baselineMedianDeltaMs", "T")]:
                    cell = summary.find(f".//m:c[@r='{column}{index}']", namespace)
                    if row[field] is None:
                        assert cell is None or cell.find("m:v", namespace) is None or not cell.find("m:v", namespace).text
                    else:
                        assert cell is not None and cell.attrib.get("t") not in {"s", "inlineStr", "str", "e"}
                        assert math.isclose(float(cell.find("m:v", namespace).text), row[field], abs_tol=1e-8)
                        if column in {"R", "T"}:
                            assert cell.find("m:f", namespace) is not None
            charts = [name for name in archive.namelist() if re.fullmatch(r"xl/(?:drawings/)?charts/chart\d+\.xml", name)]
            assert len(charts) == 2, charts
            chart_checks = json.loads((root / "xlsx-charts.json").read_text(encoding="utf-8"))
            chart_namespace = {"c": "http://schemas.openxmlformats.org/drawingml/2006/chart", "a": "http://schemas.openxmlformats.org/drawingml/2006/main"}
            for name in charts:
                chart = ET.fromstring(archive.read(name))
                assert chart.find(".//c:barChart", chart_namespace) is not None
                references = [node.text for node in chart.findall(".//c:f", chart_namespace)]
                assert references and all("Impact charts" in value for value in references), references
                assert any(re.search(r"!?\$?A\$?\d+", value) for value in references), references
                colors = [node.attrib.get("val") for node in chart.findall(".//a:srgbClr", chart_namespace)]
                assert any(color in {"087F8C", "3657A7"} for color in colors), colors
                if any(item.get("zeroAxisReference") for item in chart_checks["charts"]):
                    title = "".join(node.text or "" for node in chart.findall(".//c:title//a:t", chart_namespace))
                    if title == "Full response (ms)":
                        series = chart.findall(".//c:barChart/c:ser", chart_namespace)
                        assert len(series) == 2, "Full-response bars require the separate zero-origin reference"
                        zero_formula = series[1].find("c:val/c:numRef/c:f", chart_namespace)
                        candidate_count = len({row["candidate"] for row in results["summaries"]})
                        first_point = chart_checks["plotStart"] + 1
                        last_point = chart_checks["plotStart"] + candidate_count
                        assert zero_formula is not None and zero_formula.text == f"'Impact charts'!$D${first_point}:$D${last_point}"
                        cache_count = series[1].find("c:val/c:numRef/c:numCache/c:ptCount", chart_namespace)
                        cached = [float(node.text) for node in series[1].findall("c:val/c:numRef/c:numCache/c:pt/c:v", chart_namespace)]
                        # A reference-only chart can have an explicit empty cache.
                        # Every referenced worksheet cell is checked below instead.
                        assert cache_count is not None and int(cache_count.attrib["val"]) == len(cached)
                        assert len(cached) in {0, candidate_count} and all(value == 0 for value in cached)
            chart_data = ET.fromstring(archive.read("xl/worksheets/sheet5.xml"))
            for address in ["B3", "B4"]:
                assert float(chart_data.find(f".//m:c[@r='{address}']/m:v", namespace).text) == 1
            assert chart_checks["selectorChecks"] >= 2 and len(chart_checks["charts"]) == 2
            if "plotStart" in chart_checks:
                candidates = list(dict.fromkeys(row["candidate"] for row in results["summaries"]))
                cohort = results["summaries"][0]["cohort"]
                for offset, candidate in enumerate(candidates):
                    if any(item.get("zeroAxisReference") for item in chart_checks["charts"]):
                        zero_cell = chart_data.find(f".//m:c[@r='D{chart_checks['plotStart'] + offset + 1}']", namespace)
                        assert zero_cell is not None and float(zero_cell.find("m:v", namespace).text) == 0
                        assert zero_cell.find("m:f", namespace).text == "0"
                    row = next((item for item in results["summaries"] if item["candidate"] == candidate and item["cohort"] == cohort and item["eligible"]), None)
                    for column, field in [("B", "leadingMs"), ("C", "baselineDeltaMs")]:
                        cell = chart_data.find(f".//m:c[@r='{column}{chart_checks['plotStart'] + offset + 1}']", namespace)
                        assert cell is not None and cell.find("m:f", namespace) is not None
                        assert "NA()" in cell.find("m:f", namespace).text
                        expected = row[field] if row else None
                        if expected is None:
                            assert cell.attrib.get("t") == "e" and cell.find("m:v", namespace).text == "#N/A"
                        else:
                            assert math.isclose(float(cell.find("m:v", namespace).text), expected, abs_tol=1e-8)
        if results.get("reportVersion", 0) >= 3:
            group_sheet = ET.fromstring(archive.read("xl/worksheets/sheet6.xml"))
            group_rows = results["groupSummaries"]
            assert len(group_sheet.findall("m:sheetData/m:row", namespace)) == len(group_rows) + 1
            fields = [("E", "scenarioCount"), ("F", "requestedScenarioCount"), ("G", "measuredCalls"), ("H", "warmupCalls"), ("I", "saveCalls"), ("J", "averageLeadingMs"), ("K", "baselineLeadingMs"), ("L", "baselineDeltaMs"), ("M", "averageMedianMs"), ("N", "baselineMedianMs"), ("O", "baselineMedianDeltaMs"), ("P", "averageRequestMs"), ("Q", "baselineRequestMs"), ("R", "baselineRequestDeltaMs")]
            for index, row in enumerate(group_rows, start=2):
                for column, field in fields:
                    cell = group_sheet.find(f".//m:c[@r='{column}{index}']", namespace)
                    if row[field] is None:
                        assert cell is None or cell.find("m:v", namespace) is None or not cell.find("m:v", namespace).text
                    else:
                        assert cell is not None and cell.attrib.get("t") not in {"s", "inlineStr", "str", "e"}
                        assert math.isclose(float(cell.find("m:v", namespace).text), row[field], abs_tol=1e-8)
                        if row["scenarioCount"] and column not in {"E", "F", "I"}:
                            assert cell.find("m:f", namespace) is not None
            group_checks = json.loads((root / "xlsx-groups.json").read_text(encoding="utf-8"))
            assert group_checks["rowsChecked"] == len(group_rows)
            if any(row["group"] == "saving" and row["scenarioCount"] and not row["baseline"] and any(other["candidate"] == row["candidate"] and other["runtimeGroup"] == row["runtimeGroup"] and other["group"] == "back-end" and other["scenarioCount"] for other in group_rows) for row in group_rows):
                assert group_checks["saveIsolationChecked"]
        if config.get("comparisonMode") == "repeat-controls":
            repeat_sheet = ET.fromstring(archive.read("xl/worksheets/sheet7.xml"))
            assert len(repeat_sheet.findall("m:sheetData/m:row", namespace)) == len(results["controls"]) + 1
            for index, row in enumerate(results["controls"], start=2):
                for column, field in [("E", "controlMinimumSpreadMs"), ("F", "controlMedianSpreadMs"), ("G", "minimumDeltaMs"), ("H", "minimumLowMs"), ("I", "minimumHighMs"), ("J", "medianDeltaMs"), ("K", "medianLowMs"), ("L", "medianHighMs")]:
                    cell = repeat_sheet.find(f".//m:c[@r='{column}{index}']", namespace)
                    assert cell is not None and cell.attrib.get("t") not in {"s", "inlineStr", "str", "e"}
                    assert math.isclose(float(cell.find("m:v", namespace).text), row[field], abs_tol=1e-8)
    xlsx_checked = True

output = {
    "verified": True, "status": "complete", "measured": phases["measure"], "warmups": phases["warmup"],
    "blocks": len(results["blocks"]), "summaries": len(results["summaries"]),
    "durableBlockCheckpoints": len(durable_checkpoints),
    "samplesPerScenario": config["samples"], "rounds": config["rounds"],
    "xlsxRowCountsAndTypes": xlsx_checked,
    "missingTemperatureReadings": sum(not row["celsius"] for row in temperatures),
    "cpuIntervals": len(load_readings),
    "cacheObservationBlocks": len(cache_readings),
    "observedCacheReuseBlocks": sum(row["status"] == "observed-reuse" for row in cache_readings),
    "missingCPUIntervals": sum(row["percent"] == "" for row in load_readings),
    "clockReadings": len(clock_readings),
    "missingClockReadings": sum(row["minimumMHz"] == "" for row in clock_readings),
    "signedBaselineAndOfflineHTML": results.get("reportVersion", 0) >= 2,
    "nativeComparisonCharts": xlsx_checked and results.get("reportVersion", 0) >= 2,
    "groupAveragesAndSaveCounts": results.get("reportVersion", 0) >= 3,
    "repeatControlAssessment": config.get("comparisonMode") == "repeat-controls",
    "frontEndOutputComparison": results.get("reportVersion", 0) >= 4,
    "verifiedOutputResponses": sum(record["status"] == "available" for record in results.get("outputComparison", {}).get("records", [])),
}
(root / "verification.json").write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
print(json.dumps(output, indent=2))
