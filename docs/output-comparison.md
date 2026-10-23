# Front-end output comparison

Every generated `report.html` includes an output matrix for the selected public
HTML workload. Changing the runtime or page changes both the timing cohort and
the output matrix. The WordPress control remains visible. Feeds, XML sitemaps,
robots.txt, redirects, admin screens and saves are not scored as HTML pages.

The report also writes `output-comparison.json`, `output-comparison.csv` and
`output-comparison.md`. Markdown contains all page matrices and exact selected
SEO tags/JSON-LD. The HTML shows the same data, with expandable exact output,
the source response, round, native route and body SHA-256. It uses DOM text and
escaped JSON; captured markup is never executed and no external assets are loaded.

## Evidence and scope

Extraction runs after measurements. It makes no HTTP calls and changes no
instrumentation, settings, sampling budget or timing values. For each exact
candidate/runtime/scenario cell it chooses the fastest accepted measured response
across its rounds. It verifies the saved `.fastest.json` against that raw sample:
body hash, duration, request/response token, public user, native route, status and
HTML content type. The output always represents that response, even when the
chart metric is changed to median. It is not an assertion that all responses
contained identical metadata.

Missing, mismatched or ineligible evidence is **Unavailable**, not an absence or
a zero. An offline `report` on a copy of a historical run adds the comparison
where its original bodies and raw evidence survive. Never fetch missing pages,
silently repeat measurements or change plugin code to fill the table.

Both head and footer JSON-LD are included. Comments, inert templates, scripts
and styles do not manufacture meta tags. Numeric and common named HTML references
are decoded; a description containing unresolved named references does not receive
a fabricated exact character count. JSON-LD is parsed locally without fetching
contexts or linked data. Custom context aliases are not expanded.

## Read differences in context

The table reports observed output, not plugin capability or an SEO quality score.
`No` means absent in that response; `Empty` means emitted with no value. Schema
types include nested and multi-typed objects. `URL only` distinguishes a minimal
typed reference from a detailed entity. Person/ImageObject roles follow local
properties and `@id` references, so an author or logo is not mistaken for the
page's content type.

- WordPress already supplies some titles, canonicals and robots tags. Compare
  the core column before calling an element plugin-added output.
- A WordPress page/post is a storage/query distinction. Schema types describe
  content and entities. A page can have a Person author or publisher, or an
  ImageObject for its logo/main image. Article must describe article content;
  a WordPress `page` alone neither proves nor disproves its suitability.
- Missing duplicate Twitter tags with available Open Graph values are recorded
  separately. They do not prove a broken social card. This suite does not render
  social cards or contact a social platform to verify its behavior.
- Description length has no universal pass/fail threshold. A short excerpt,
  missing auto-description or long description is an observed setup difference;
  assess usefulness and content before calling it a fault.
- BreadcrumbList, SearchAction and ReadAction are not mandatory just because
  another plugin emits them. SearchAction presence does not establish a Google
  sitelinks search box benefit; that feature was retired.
- JSON syntax failures and duplicate/empty metadata are shown for review.
  Passing JSON syntax is not semantic Schema.org validation, verified accuracy
  or Google rich-result eligibility. The report does not apply a universal
  red/green score or an automatic performance penalty for output differences.

Use a separately documented, content-specific expectation when testing semantic
correctness. Do not encode a competing product's choices as universal rules or
mark every difference from a preferred product as an error. Account/setup notes
and private plugin details belong to the consumer's private case, never the
public engine or skill.

## Primary references

- [Schema.org WebPage](https://schema.org/WebPage)
- [Schema.org author](https://schema.org/author) and [publisher](https://schema.org/publisher)
- [Schema.org primaryImageOfPage](https://schema.org/primaryImageOfPage) and [logo](https://schema.org/logo)
- [Schema.org Article](https://schema.org/Article)
- [Google description guidance](https://developers.google.com/search/docs/appearance/snippet)
- [Google's sitelinks search box retirement](https://developers.google.com/search/blog/2024/10/sitelinks-search-box)

These references explain interpretation; the engine never needs network access
to derive a report from saved measurements.
