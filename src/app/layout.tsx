import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "daylight | Personal schedule",
  description: "A calmer way to plan lessons, energy, and time.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
