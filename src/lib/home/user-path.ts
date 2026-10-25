/**
 * The signed-in user's home: one straight line of five steps, the first unfinished one is "now" and carries the one main button.
 * Pure function of counts the page reads (through RLS), so the order and the wording are testable.
 */
export type PathInput = {
  sitesConnected: number;
  mapsReady: number;
  latestMapId: string | null;
  itemsApproved: number;
  articlesReady: number;
  draftsSent: number;
  /** a ready article not yet sent to WordPress */
  unsent: { runId: string; articleId: string } | null;
};
export type PathStep = { key: "site" | "map" | "plan" | "write" | "send"; title: string; hint: string; done: boolean; href: string; cta: string; doneText: string };

export function userPath(i: PathInput): { steps: PathStep[]; now: number } {
  const map = i.latestMapId ? `/maps/${i.latestMapId}` : "/maps";
  const steps: PathStep[] = [
    { key: "site", title: "Connect your WordPress site", hint: "Once. Your articles are saved there as drafts; nothing is published without you.", done: i.sitesConnected > 0, href: "/sites", cta: "Connect WordPress", doneText: `${i.sitesConnected} site${i.sitesConnected === 1 ? "" : "s"} connected` },
    { key: "map", title: "Get your topical map", hint: "The map is your article plan: every article, grouped by topic. It is started from the admin area for now.", done: i.mapsReady > 0, href: "/maps", cta: "Open maps", doneText: `${i.mapsReady} map${i.mapsReady === 1 ? "" : "s"} ready` },
    { key: "plan", title: "Approve the articles you want", hint: "Look through the plan and approve the good ideas. Only approved ideas get written.", done: i.itemsApproved > 0, href: map, cta: "Review the plan", doneText: `${i.itemsApproved} idea${i.itemsApproved === 1 ? "" : "s"} approved` },
    { key: "write", title: "Write your articles", hint: "Group approved ideas into a batch and press write. Each finished article gets a traffic light and a translation to check.", done: i.articlesReady > 0, href: map, cta: "Write a batch", doneText: `${i.articlesReady} article${i.articlesReady === 1 ? "" : "s"} ready` },
    { key: "send", title: "Send a draft to WordPress", hint: "Open a ready article, read it, and press “Send to WordPress as draft”.", done: i.draftsSent > 0, href: i.unsent ? `/maps/${i.unsent.runId}/articles/${i.unsent.articleId}` : map, cta: "Open an article", doneText: `${i.draftsSent} draft${i.draftsSent === 1 ? "" : "s"} sent` },
  ];
  const now = steps.findIndex((s) => !s.done);
  return { steps, now };
}
