import ConnectFlow from "../components/ConnectFlow.js";

export default function Home() {
  return (
    <main className="shelf">
      <p className="eyebrow">CLI-first demo · Moksha Testnet</p>
      <h1>Research Shelf</h1>
      <p className="intro">
        Bring your Perplexity conversations into your own app through Vana.
      </p>
      <ConnectFlow />
      <section className="card threads" aria-labelledby="threads-title">
        <h2 id="threads-title">Your threads</h2>
        <p className="empty-state">No threads loaded.</p>
        <p>
          Conversation titles and last-updated times will appear here once data
          reads are enabled.
        </p>
      </section>
      <p className="scope-note">
        This demo prepares approval for Perplexity conversations only. Data
        reads and payments are not enabled yet.
      </p>
    </main>
  );
}
