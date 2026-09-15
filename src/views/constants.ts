/**
 * The public NPHIES Confluence space every provenance quote came from.
 *
 * `{pageId}` is substituted per link: Confluence Cloud addresses a page by query string, so
 * the id cannot simply be appended.
 */
export const CONFLUENCE_BASE = "https://nphies.atlassian.net/wiki/pages/viewpage.action?pageId={pageId}";
