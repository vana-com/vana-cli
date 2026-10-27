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
      <p className="scope-note">
        Reads use this app’s own grant and capped Moksha test VANA payments.
        Your saved list stays available if a later read fails.
      </p>
    </main>
  );
}
