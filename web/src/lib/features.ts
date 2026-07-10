/** The single feature registry (§12.3). The Play hub renders from this; a landing page / tracker can
 * render from the same list so the product, its marketing, and its status never drift. Flip `status`
 * to 'live' when a game ships and it lights up everywhere. Unbuilt features simply don't render. */
export type GameStatus = "live" | "soon";
export type Game = {
  id: string;
  name: string;
  blurb: string;
  status: GameStatus;
  /** Which tab hosts it (for deep-linking from the hub). */
  tab: "today" | "live" | "squad";
};

export const GAMES: Game[] = [
  { id: "survivor", name: "Daily free call", blurb: "One free call a day. Miss none, keep your run alive.", status: "live", tab: "today" },
  { id: "hilo", name: "Hi-Lo", blurb: "More or less than the last match? Build a streak.", status: "live", tab: "today" },
  { id: "quests", name: "Today's goals", blurb: "Three goals a day. Small wins that stack up.", status: "live", tab: "today" },
  { id: "pools", name: "Live pools", blurb: "Call what happens next — split the pot if you're right.", status: "live", tab: "today" },
  { id: "ask", name: "Ask your own", blurb: "Say it how you'd say it to a mate. If the match data can prove it, a pool opens.", status: "live", tab: "today" },
  { id: "slip", name: "Slips", blurb: "Stack calls into one. Power needs them all; Flex pays each on its own.", status: "live", tab: "today" },
  { id: "duel", name: "Fade Duels", blurb: "Take the other side of a mate's call. One of you is wrong, and everyone sees.", status: "live", tab: "squad" },
  { id: "draft", name: "The Round Table", blurb: "Draft night between matches — pick in turn, live, with the whole squad watching.", status: "live", tab: "squad" },
  { id: "freeze", name: "The Frozen Window", blurb: "When the books freeze on a VAR review, our round opens.", status: "live", tab: "live" },
  { id: "calledshot", name: "Called Shot", blurb: "Seal a one-liner. Opened only if you called it right.", status: "live", tab: "squad" },
  { id: "fansvsmarket", name: "Fans vs the Market", blurb: "The room's call vs the live market — pick the gap.", status: "live", tab: "today" },
  { id: "bracket", name: "The knockout board", blurb: "Every match as it goes live and finishes — the whole tournament at a glance.", status: "live", tab: "today" },
  { id: "mystery", name: "Relive a match", blurb: "Any finished game replayed as a 3-minute drama run. No names until the end.", status: "live", tab: "today" },
];
