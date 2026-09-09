import Link from "next/link";
import { notFound } from "next/navigation";
import { examples } from "@/examples";

export function generateStaticParams() {
  return examples.map((example) => ({ slug: example.slug }));
}

export default async function ExamplePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const example = examples.find((entry) => entry.slug === slug);
  if (!example) notFound();
  const Component = example.component;
  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: 24 }}>
      <header style={{ marginBottom: 24 }}>
        <Link href="/" style={{ fontSize: 13, color: "#666" }}>
          &larr; Benchmark Examples
        </Link>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: "8px 0 0" }}>{example.name}</h1>
      </header>
      <Component />
    </main>
  );
}
