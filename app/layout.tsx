import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "PTS Ads Monitor",
  description: "Meta Ads account and rejection monitoring for PTS Cooperation",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="uk">
      <body>{children}</body>
    </html>
  );
}
