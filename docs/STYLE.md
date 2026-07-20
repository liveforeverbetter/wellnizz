# Documentation voice and structure

Use this guide when adding or revising wellnizz API docs.

## Voice

- Write for a developer who wants to ship a working wellness product quickly.
- Use direct, active sentences: "Upload a VCF" instead of "A VCF can be uploaded."
- Lead with the result, then explain constraints and implementation details.
- Prefer concrete endpoint names, response fields, and next steps over broad claims.
- Use "wellnizz API" on first mention and "the API" afterward.
- Use generic modality names in public copy. Mention provider brands only when a
  provider-specific setup step requires them.
- Keep wellness guidance source-backed and avoid diagnostic or treatment claims.

## Titles and labels

- Use sentence case.
- Prefer verbs for task pages: "Run an analysis", "Connect an Oura Ring".
- Prefer short nouns for concepts: "Data model", "Biomarkers".
- Write "and" in titles and navigation labels instead of an ampersand.

## Navigation

- Keep top-level groups limited to Start, Build, Use cases, Operate, and API Reference.
- Put conceptual and workflow pages under Build rather than creating a new top-level group.
- Group API operations by developer intent, not by internal module or service name.
- Add every production OpenAPI operation to one reference category exactly once.

## Examples

- Use `https://app.wellnizz.com` as the hosted base URL.
- Show bearer authentication as `Authorization: Bearer <token>`.
- Use synthetic data unless a page specifically explains personal-data handling.
- End task guides with one clear next step.
