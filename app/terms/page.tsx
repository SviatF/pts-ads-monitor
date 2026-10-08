import Link from "next/link";

export const metadata = {
  title: "Terms of Service | PTS Ads Monitor",
  description: "Terms of Service for PTS Ads Monitor.",
};

export default function TermsPage() {
  return (
    <main className="legalPage">
      <section className="legalCard">
        <div className="eyebrow">PTS Ads Monitor</div>
        <h1>Terms of Service</h1>
        <p className="legalUpdated">Last updated: October 8, 2026</p>

        <p>
          PTS Ads Monitor is an internal operational tool provided by PTS Cooperation for
          authorized advertising monitoring, performance control, and reporting workflows.
        </p>

        <h2>Authorized use</h2>
        <p>
          The service is intended only for users authorized by PTS Cooperation. Users must only
          connect advertising accounts, Google accounts, spreadsheets, and other resources that
          they are authorized to access.
        </p>

        <h2>Google services</h2>
        <p>
          By connecting Google, the user authorizes PTS Ads Monitor to access Google Drive and
          Google Sheets for the purpose of creating and maintaining PTS performance reports.
          Users may revoke this authorization through their Google Account at any time.
        </p>

        <h2>Service availability</h2>
        <p>
          The service may depend on third-party APIs and platforms, including Google and Meta.
          Availability, data delivery, authentication, quotas, and API behavior may therefore be
          affected by those providers.
        </p>

        <h2>Acceptable use</h2>
        <p>
          Users must not attempt to access resources they are not authorized to use, interfere
          with the service, extract credentials, or use the system for unlawful activity.
        </p>

        <h2>Changes</h2>
        <p>
          These terms may be updated as the internal platform and its integrations evolve.
          Continued authorized use of the service after an update constitutes acceptance of the
          revised terms.
        </p>

        <div className="legalLinks">
          <Link href="/about">About PTS Ads Monitor</Link>
          <Link href="/privacy">Privacy Policy</Link>
        </div>
      </section>
    </main>
  );
}
