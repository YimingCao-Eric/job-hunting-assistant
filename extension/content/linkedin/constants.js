/* ── LinkedIn selectors ────────────────────────────────────────────────── */

const JOB_CARD_SELECTORS = [
  "li[data-occludable-job-id]",
  ".scaffold-layout__list-item",
  "div.job-card-container",
  "li.jobs-search-results__list-item",
];

const NEXT_BUTTON_SELECTORS = [
  'button[aria-label="View next page"]',
  ".artdeco-pagination__button--next",
  "button.jobs-search-pagination__button--next",
  'button[aria-label*="next"]',
  "li.artdeco-pagination__indicator--number + li button",
];

const PAGINATION_CONTAINER_SELECTORS = [
  ".jobs-search-pagination",
  ".artdeco-pagination",
  '[aria-label="Pagination"]',
];
