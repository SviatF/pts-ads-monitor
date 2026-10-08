import Link from "next/link";

export const metadata = {
  title: "PTS Ads Monitor",
  description: "Internal advertising monitoring and reporting platform by PTS Cooperation.",
};

export default function AboutPage() {
  return (
    <main className="legalPage">
      <section className="legalCard">
        <div className="eyebrow">PTS Cooperation</div>
        <h1>PTS Ads Monitor</h1>
        <p>
          PTS Ads Monitor is an internal advertising operations platform used by PTS Cooperation
          to monitor advertising accounts, maintain performance reporting, and synchronize
          authorized reporting data with Google Sheets.
        </p>

        <h2>Google integrations</h2>
        <p>
          When an authorized PTS user connects Google, the application may access Google Drive
          and Google Sheets only to create, open, and update performance reports required for
          PTS advertising operations.
        </p>

        <h2>Access</h2>
        <p>
          The operational dashboard is restricted to authorized PTS personnel. Public information
          about privacy and service terms is available below.
        </p>

        <div className="legalLinks">
          <Link href="/privacy">Privacy Policy</Link>
          <Link href="/terms">Terms of Service</Link>
        </div>
      </section>
    </main>
  );
}
