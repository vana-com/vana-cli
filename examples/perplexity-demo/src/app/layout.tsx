import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Research Shelf — Perplexity demo",
  description: "A Perplexity conversations demo using Vana on Moksha",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
