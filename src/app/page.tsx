import Link from "next/link";
import { Logo } from "@/components/brand";

type Status = "done" | "writing" | "todo";

const SILOS: { title: string; sub: string; rows: { t: string; s: Status }[]; more: number }[] = [
  {
    title: "Peinados para cabello rizado",
    sub: "Pillar and 41 articles",
    rows: [
      { t: "Peinados fáciles para cabello rizado", s: "done" },
      { t: "Cómo definir rizos sin encrespar", s: "done" },
      { t: "Peinados rizados para trabajar", s: "writing" },
      { t: "Recogidos con rizos para boda", s: "todo" },
    ],
    more: 37,
  },
  {
    title: "Peinados para cabello corto",
    sub: "Pillar and 38 articles",
    rows: [
      { t: "Cortes pixie con volumen", s: "done" },
      { t: "Peinados cortos para cara redonda", s: "writing" },
      { t: "Cómo peinar un bob ondulado", s: "todo" },
      { t: "Peinados cortos con flequillo", s: "todo" },
    ],
    more: 34,
  },
  {
    title: "Trenzas y recogidos",
    sub: "Pillar and 44 articles",
    rows: [
      { t: "Trenza de espiga paso a paso", s: "done" },
      { t: "Trenzas para niñas con prisa", s: "todo" },
      { t: "Moño bajo elegante en 5 minutos", s: "todo" },
      { t: "Recogidos con trenza para fiesta", s: "todo" },
    ],
    more: 40,
  },
];

const STEPS = [
  { h: "Pick a topic", p: "Type the niche and the language you write in. That is all we ask for." },
  { h: "Review the map", p: "We build the full topical map and remove articles that answer the same question twice." },
  { h: "Publish to WordPress", p: "Articles are written in batches and scheduled on your site, with your call to action on every post." },
  { h: "Pin it", p: "Each article gets pin images and copy, ready for Pinterest." },
];

export default function Home() {
  return (
    <>
      <header className="pm-hero">
        <div className="pm-wrap">
          <div className="pm-topbar">
            <Logo />
            <Link href="/login" className="pm-btn pm-btn-quiet pm-btn-sm">
              Sign in
            </Link>
          </div>

          <div className="pm-hero-grid">
            <div>
              <h1 className="pm-display">One topic in. A whole site, mapped and pinned.</h1>
              <p className="pm-lede">
                PinMentor turns a niche into a checked map of hundreds of articles, writes them, publishes them to
                WordPress and makes the Pinterest pins that send readers back.
              </p>
              <div className="pm-actions">
                <Link href="/login" className="pm-btn pm-btn-primary">
                  Start free
                </Link>
                <Link href="#how" className="pm-btn pm-btn-ghost">
                  See how it works
                </Link>
              </div>
              <p className="pm-fine">No password. We email you a one-time sign-in link.</p>
            </div>

            <div className="pm-board" role="img" aria-label="Example topical map for hairstyles in Spanish, three groups of articles with their writing status">
              <div className="pm-board-head">
                <div className="pm-board-topic">
                  Peinados
                  <small>Spanish, 3 of 9 groups shown</small>
                </div>
                <div className="pm-board-counts">
                  <span>
                    <b>126</b>articles
                  </span>
                  <span>
                    <b>24</b>duplicates removed
                  </span>
                </div>
              </div>
              <div className="pm-board-cols">
                {SILOS.map((silo) => (
                  <div key={silo.title} className="pm-silo">
                    <h3>
                      {silo.title}
                      <span>{silo.sub}</span>
                    </h3>
                    {silo.rows.map((r) => (
                      <div key={r.t} className="pm-row">
                        <i className={`pm-st ${r.s === "done" ? "pm-st-done" : r.s === "writing" ? "pm-st-writing" : ""}`} />
                        <span>{r.t}</span>
                      </div>
                    ))}
                    <div className="pm-more">+ {silo.more} more</div>
                  </div>
                ))}
              </div>
              <div className="pm-board-foot">
                <span className="pm-legend">
                  <i className="pm-st pm-st-done" /> Published
                </span>
                <span className="pm-legend">
                  <i className="pm-st pm-st-writing" /> Writing
                </span>
                <span className="pm-legend">
                  <i className="pm-st" /> Planned
                </span>
                <span className="pm-progress">
                  <span />
                </span>
                <span>19% published</span>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main id="how" className="pm-band">
        <div className="pm-wrap pm-band-in">
          <h2 className="pm-section-title">From a topic to scheduled posts</h2>
          <ol className="pm-steps">
            {STEPS.map((s, i) => (
              <li key={s.h} className="pm-step">
                <span className="pm-step-n">{i + 1}</span>
                <h3>{s.h}</h3>
                <p>{s.p}</p>
              </li>
            ))}
          </ol>
        </div>
      </main>

      <footer className="pm-wrap pm-footer">
        <Logo />
        <span>Trial credits are granted once your email is confirmed.</span>
      </footer>
    </>
  );
}
