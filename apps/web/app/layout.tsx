import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Botswana Cadastral System",
  description:
    "Cadastral survey data processing — COGO, traverse adjustment, parcel construction, and SG/General/Working plan generation.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
