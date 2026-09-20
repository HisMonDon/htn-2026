import styles from "./BuiltWith.module.css";

interface BuiltWithItem {
  name: string;
  slug: string;
}

const items: BuiltWithItem[] = [
  { name: "gptzero", slug: "gptzero" },
  { name: "github", slug: "github" },
  { name: "next.js", slug: "nextjs" },
  { name: "typescript", slug: "typescript" },
  { name: "python", slug: "python" },
];

// Duplicated so the marquee track can loop seamlessly at -50%.
const track = [...items, ...items];

export default function BuiltWith() {
  return (
    <div className={styles.root}>
      <span className={styles.label}>Built with:</span>

      <div className={styles.viewport}>
        <ul className={styles.track}>
          {track.map((item, index) => (
            <li key={`${item.slug}-${index}`} className={styles.item}>
              <img
                src={`/icons/${item.slug}.svg`}
                alt=""
                aria-hidden="true"
                className={styles.icon}
              />
              <span>{item.name}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
