/**
 * BullMQ handler for `membership:sync` jobs. Runs the AAIF scraper.
 */
import { runAaifSync } from '../scripts/aaif-member-scraper.js';

export default async function handler(job) {
  const sourceUrl = job?.data?.source_url ?? 'https://aaif.io/members/';
  return runAaifSync({ sourceUrl });
}
