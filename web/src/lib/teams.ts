/** National-team visual identity — the legal-clean way to make every surface feel like the World Cup.
 * Flags are public domain (rendered as crisp SVGs via flag-icons); federation crests and player photos
 * are trademarked/licensed, so we never use them — a designed roundel (flag + code) stands in.
 * `primary`/`secondary` are each nation's recognised kit colors, powering per-match theming. */

export type Team = { iso: string; code: string; primary: string; secondary: string };

// Keyed by the exact participant names TxLINE uses (lowercased for lookup).
const TEAMS: Record<string, Team> = {
  "usa":                  { iso: "us", code: "USA", primary: "#1F2E5A", secondary: "#BF0A30" },
  "bosnia & herzegovina": { iso: "ba", code: "BIH", primary: "#002F6C", secondary: "#FFCB05" },
  "spain":                { iso: "es", code: "ESP", primary: "#AA151B", secondary: "#F1BF00" },
  "austria":              { iso: "at", code: "AUT", primary: "#ED2939", secondary: "#FFFFFF" },
  "portugal":             { iso: "pt", code: "POR", primary: "#C8102E", secondary: "#046A38" },
  "croatia":              { iso: "hr", code: "CRO", primary: "#ED1C24", secondary: "#FFFFFF" },
  "switzerland":          { iso: "ch", code: "SUI", primary: "#D52B1E", secondary: "#FFFFFF" },
  "algeria":              { iso: "dz", code: "ALG", primary: "#006233", secondary: "#FFFFFF" },
  "australia":            { iso: "au", code: "AUS", primary: "#FFB81C", secondary: "#00843D" },
  "egypt":                { iso: "eg", code: "EGY", primary: "#CE1126", secondary: "#FFFFFF" },
  "argentina":            { iso: "ar", code: "ARG", primary: "#75AADB", secondary: "#FFFFFF" },
  "cape verde":           { iso: "cv", code: "CPV", primary: "#003893", secondary: "#CF2027" },
  "mexico":               { iso: "mx", code: "MEX", primary: "#006847", secondary: "#CE1126" },
  "england":              { iso: "gb-eng", code: "ENG", primary: "#FFFFFF", secondary: "#CE1124" },
  "belgium":              { iso: "be", code: "BEL", primary: "#E30613", secondary: "#FDDA24" },
  "brazil":               { iso: "br", code: "BRA", primary: "#FFDC02", secondary: "#00A859" },
  "canada":               { iso: "ca", code: "CAN", primary: "#C8102E", secondary: "#FFFFFF" },
  "colombia":             { iso: "co", code: "COL", primary: "#FCD116", secondary: "#003893" },
  "france":               { iso: "fr", code: "FRA", primary: "#002395", secondary: "#FFFFFF" },
  "ghana":                { iso: "gh", code: "GHA", primary: "#FFFFFF", secondary: "#CE1126" },
  "morocco":              { iso: "ma", code: "MAR", primary: "#C1272D", secondary: "#006233" },
  "myanmar":              { iso: "mm", code: "MYA", primary: "#FECB00", secondary: "#EA2839" },
  "norway":               { iso: "no", code: "NOR", primary: "#BA0C2F", secondary: "#00205B" },
  "paraguay":             { iso: "py", code: "PAR", primary: "#D52B1E", secondary: "#0038A8" },
  "vietnam":              { iso: "vn", code: "VIE", primary: "#DA251D", secondary: "#FFFF00" },
  "germany":              { iso: "de", code: "GER", primary: "#FFFFFF", secondary: "#000000" },
  "netherlands":          { iso: "nl", code: "NED", primary: "#FF4F00", secondary: "#FFFFFF" },
  "japan":                { iso: "jp", code: "JPN", primary: "#002FA7", secondary: "#FFFFFF" },
  "italy":                { iso: "it", code: "ITA", primary: "#0066B2", secondary: "#FFFFFF" },
  "uruguay":              { iso: "uy", code: "URU", primary: "#7BAFD4", secondary: "#000000" },
  "senegal":              { iso: "sn", code: "SEN", primary: "#00853F", secondary: "#FDEF42" },
  "south korea":          { iso: "kr", code: "KOR", primary: "#CD2E3A", secondary: "#FFFFFF" },
  "saudi arabia":         { iso: "sa", code: "KSA", primary: "#006C35", secondary: "#FFFFFF" },
  "ecuador":              { iso: "ec", code: "ECU", primary: "#FFDD00", secondary: "#034EA2" },
  "nigeria":              { iso: "ng", code: "NGA", primary: "#008751", secondary: "#FFFFFF" },
};

const FALLBACK: Team = { iso: "", code: "", primary: "#1C1C1E", secondary: "#9CA3AF" };

/** Look up a team by the name the data feed uses. Tolerant of case; falls back to neutral identity. */
export function team(name: string | undefined | null): Team {
  if (!name) return FALLBACK;
  const t = TEAMS[name.trim().toLowerCase()];
  return t || { ...FALLBACK, code: name.slice(0, 3).toUpperCase() };
}
