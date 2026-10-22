// Broad regions a recruiter can say they work best in (My profile), as ISO country codes. A
// country can be in more than one (Mexico: North America and Latin America). The app shows the
// same region names (WORLD_REGIONS in app.jsx); keep the two lists in step.
export const WORLD_REGIONS: Record<string, string[]> = {
  "Africa": "DZ AO BJ BW BF BI CV CM CF TD KM CG CD CI DJ EG GQ ER SZ ET GA GM GH GN GW KE LS LR LY MG MW ML MR MU YT MA MZ NA NE NG RE RW SH ST SN SC SL SO ZA SS SD TZ TG TN UG EH ZM ZW".split(" "),
  "Middle East": "AE BH IL IQ IR JO KW LB OM PS QA SA SY TR YE EG".split(" "),
  "Europe": "AD AL AT BA BE BG BY CH CY CZ DE DK EE ES FI FO FR GB GG GI GR HR HU IE IM IS IT JE LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SK SM UA VA XK".split(" "),
  "Asia": "AF AM AZ BD BN BT CN GE HK ID IN JP KG KH KP KR KZ LA LK MM MN MO MV MY NP PH PK SG TH TJ TL TM TW UZ VN".split(" "),
  "North America": "US CA MX BM GL PM".split(" "),
  "Latin America & Caribbean": "AG AI AR AW BB BL BO BQ BR BS BZ CL CO CR CU CW DM DO EC FK GD GF GP GT GY HN HT JM KN KY LC MF MQ MS MX NI PA PE PR PY SR SV SX TC TT UY VC VE VG VI".split(" "),
  "Oceania": "AS AU CK FJ FM GU KI MH MP NC NF NR NU NZ PF PG PN PW SB TK TO TV VU WF WS".split(" "),
};

// Which of someone's regions (broad regions or country names) a country code falls in, or "".
export function regionMatch(regions: unknown, code: string, countryName: string): string {
  if (!code && !countryName) return "";
  const list = (Array.isArray(regions) ? regions : []).map((r) => String(r || "").trim()).filter(Boolean);
  const name = countryName.trim().toLowerCase();
  const byCountry = list.find((r) => r.toLowerCase() === name);
  if (byCountry) return byCountry;
  return list.find((r) => (WORLD_REGIONS[r] || []).includes(code)) || "";
}
