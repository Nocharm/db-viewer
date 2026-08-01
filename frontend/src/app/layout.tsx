import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "db-viewer",
  description: "MSSQL schema, lineage and relation explorer",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
