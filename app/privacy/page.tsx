import Link from "next/link";

export const metadata = {
  title: "Privacy Policy | PTS Ads Monitor",
  description: "Privacy Policy for PTS Ads Monitor.",
};

export default function PrivacyPage() {
  return (
    <main className="legalPage">
      <section className="legalCard">
        <div className="eyebrow">PTS Ads Monitor</div>
        <h1>Privacy Policy</h1>
        <p className="legalUpdated">Last updated: October 8, 2026</p>

        <p>
          PTS Ads Monitor is an internal advertising monitoring and reporting platform operated
          by PTS Cooperation. This Privacy Policy explains how the application handles information
          when authorized users connect Google services or use the reporting system.
        </p>

        <h2>Information we process</h2>
        <p>
          The application may process advertising account identifiers, campaign performance data,
          reporting configuration, project names, Telegram routing information, and operational
          status information required to provide monitoring and reporting features.
        </p>

        <h2>Google user data</h2>
        <p>
          When an authorized user connects a Google account, PTS Ads Monitor requests access to
          Google Drive and Google Sheets. This access is used only to create, locate, read, and
          update PTS performance reporting spreadsheets and related files that the authorized user
          has chosen to use with the service.
        </p>
        <p>
          Google OAuth credentials, including the refresh token required for continued authorized
          access, are stored in the application&apos;s protected backend infrastructure and are not
          displayed publicly.
        </p>

        <h2>How Google data is used</h2>
        <p>
          Google user data is used only to provide the reporting functionality requested by the
          authorized user. PTS Ads Monitor does not sell Google user data, does not use it for
          advertising, and does not share it with unrelated third parties.
        </p>

        <h2>Data retention and deletion</h2>
        <p>
          Operational configuration and reporting references may be retained while a project is
          active and afterwards when required for internal business records. An authorized user
          may revoke Google access at any time from their Google Account permissions. Access can
          also be disconnected by removing the Google authorization used by PTS Ads Monitor.
        </p>

        <h2>Security</h2>
        <p>
          Access to the operational dashboard is restricted. Credentials and backend configuration
          are stored server-side and are not intended to be exposed to end users or the public.
        </p>

        <h2>Contact</h2>
        <p>
          Questions about this policy or Google data handling can be sent to the developer contact
          email configured for the PTS Ads Monitor Google Cloud project.
        </p>

        <div className="legalLinks">
          <Link href="/about">About PTS Ads Monitor</Link>
          <Link href="/terms">Terms of Service</Link>
        </div>
      </section>
    </main>
  );
}
