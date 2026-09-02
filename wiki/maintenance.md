# Wiki Maintenance

Wiki pages and raw-source metadata are agent-authored. Generated indexes are derived routing artifacts.

## Front Matter Metadata

- `summary` is required for routable pages and should stay concise. `wiki clean` warns above 240 characters.
- `paths` is optional and names repository files or directories the page helps explain.
- `read_more` is optional lateral routing for a specific next page that is not obvious from the generated index hierarchy; use it sparingly and omit it from most pages.
- Update front matter when a page's knowledge scope changes.

When creating a nested knowledge directory, add an `index.md` with only a `summary` in front matter. `wiki clean` generates and maintains the index body.

## Page Structure

These are not hard rules but heuristics:

- Keep one cohesive subject per page.
- Keep indexes small enough to route cheaply. Roughly 10–20 entries is a useful heuristic, not a limit.
- Split large knowledge areas into meaningful nested directories. The hierarchy may recurse as needed.
- Keep supporting evidence under `raw/`.

## Raw Sources

Raw sources are evidence captured into the wiki, often copied from original human-authored documents or created from confirmed interviews.

- When first ingesting a Markdown source, add front matter containing only a concise `summary` describing what the source is and why it matters. Write summaries as routing signals. A summary should help an agent decide whether to open the page from an index, including the behaviors or boundaries that distinguish it from neighboring pages.
- Preserve the source body as captured. After a raw source is created, do not edit that file without explicit user approval.
- `wiki clean` generates `raw/index.md` from raw Markdown summaries, including Markdown stored in nested raw directories.
- Non-Markdown evidence may live under `raw/` unchanged; it is not included in the generated raw index.

## Context Log

`log.md` is an append-only record for durable historical context that cannot be cheaply reconstructed from Git, the current wiki, or raw evidence. Use it for things like important architecture decisions or reversals and meaningful approaches that were tried and abandoned. Most changes should not add a log entry.

## Cleanup

After adding, moving, renaming, deleting, or materially changing wiki pages or ingesting raw Markdown sources, run `wiki clean` to regenerate indexes from current metadata and structure. Fix reported errors and useful warnings in the owning metadata.
