import ConnectFlow from "@/components/ConnectFlow";

export default function Home() {
  return (
    <main style={{ maxWidth: 540, margin: "0 auto", padding: "64px 24px" }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 8 }}>
        Vana Connect | Next.js Starter
      </h1>
      <p style={{ fontSize: 14, color: "#71717a", marginBottom: 40 }}>
        Connect your ChatGPT data through Vana and read the approved data in
        this Next.js app.
      </p>
      <ConnectFlow />
    </main>
  );
}
