import Link from "next/link";
import { examples } from "@/examples";

export default function Home() {
  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: 24 }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 4 }}>Benchmark Examples</h1>
      <p style={{ fontSize: 13, color: "#666", marginTop: 0, marginBottom: 16 }}>
        Self-contained scenarios to write e2e tests against.
      </p>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {examples.map((example) => (
          <li key={example.slug} style={{ borderBottom: "1px solid #e5e5e5" }}>
            <Link
              href={`/e/${example.slug}`}
              data-testid={example.name}
              style={{
                display: "block",
                padding: "14px 4px",
                textDecoration: "none",
                color: "inherit",
              }}
            >
              <span style={{ display: "block", fontSize: 16, fontWeight: 600 }}>
                {example.name}
              </span>
              <span style={{ display: "block", fontSize: 13, color: "#666", marginTop: 2 }}>
                {example.description}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
