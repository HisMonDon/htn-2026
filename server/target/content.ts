export interface Article {
  slug: string;
  headline: string;
  byline: string;
  published: string;
  paragraphs: string[];
}

/**
 * Demo content for the controlled publisher. The article repeats the fabricated citations from
 * the Cohen/Bard seed (data/cohen-bard.json) as if they were real; that is the false passage.
 */
export const ARTICLES: Article[] = [
  {
    slug: "cohen-supervised-release",
    headline: "Cohen asks court to end supervised release early",
    byline: "Staff reporter",
    published: "2023-12-01",
    paragraphs: [
      "Lawyers for Michael Cohen have asked a federal judge in Manhattan to end his supervised release early, arguing that he has complied with every condition imposed after his release from prison.",
      "The motion relies on United States v. Figueroa-Florez, United States v. Ortiz, and United States v. Amato, three Second Circuit decisions that it says granted early termination of supervised release in similar circumstances.",
      "Prosecutors have not yet filed a response. The judge has not said when he will rule.",
    ],
  },
  {
    slug: "court-calendar",
    headline: "This week on the federal court calendar",
    byline: "Calendar desk",
    published: "2023-12-04",
    paragraphs: [
      "Several sentencing hearings are scheduled in the Southern District of New York this week.",
      "Oral argument in a pending securities appeal has been moved to next month.",
    ],
  },
];
