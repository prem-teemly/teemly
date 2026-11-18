// Rules shared by the forms that add a person ("+ Add" and Inbox → Add person), so both check a phone
// number and a name the same way. The backend checks the same again (routes.js parseNewPerson).

import type { Category } from "./people";

/** Phone: a country code, then the number without it, digits only. `digits` is the length of a mobile
 * number in that country (India 10). Saved as +<code><number>, e.g. +919876543210. */
export const COUNTRIES = [
  { code: "IN", dial: "91", name: "India", digits: 10 },
  { code: "AE", dial: "971", name: "UAE", digits: 9 },
  { code: "US", dial: "1", name: "USA / Canada", digits: 10 },
  { code: "GB", dial: "44", name: "UK", digits: 10 },
  { code: "SG", dial: "65", name: "Singapore", digits: 8 },
  { code: "SA", dial: "966", name: "Saudi Arabia", digits: 9 },
  { code: "QA", dial: "974", name: "Qatar", digits: 8 },
  { code: "LK", dial: "94", name: "Sri Lanka", digits: 9 },
  { code: "AU", dial: "61", name: "Australia", digits: 9 },
] as const;
export type Country = (typeof COUNTRIES)[number];

/** Only the digits of the number, without a pasted country code or leading 0, at most the country's length. */
export function phoneDigits(raw: string, c: Country): string {
  let d = raw.replace(/\D/g, "");
  if (d.length === c.dial.length + c.digits && d.startsWith(c.dial)) d = d.slice(c.dial.length); // "+91 98765 43210"
  else if (d.length === c.digits + 1 && d.startsWith("0")) d = d.slice(1); // "098765 43210"
  return d.slice(0, c.digits);
}

/** Names and cities: letters in any script (Tamil, Hindi … with their vowel signs), spaces, . ' - */
export const NAME_LIKE = /^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u;

/**
 * The category that usually goes with a department, used when the AI could not tell the category
 * from the call but did pick a department (shown as a suggestion the owner can change).
 */
export const CATEGORY_FROM_DEPARTMENT: Record<string, Category> = {
  Investment: "Investor",
  Sales: "Business partner",
  "Channel partners": "Business partner",
  "Customer Success": "Business partner",
  "Tech & AI": "Expert",
  "Legal and Compliance": "Expert",
  Accounts: "Vendor",
  Marketing: "Vendor",
  Vendors: "Vendor",
  "Govt tenders": "Govt official",
};
