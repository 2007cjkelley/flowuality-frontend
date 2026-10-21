import "./landing.css";
import heroSections from "./heroSections";
import RevealSection from "./RevealSection";

// What a logged-out visitor sees at "/" (routes.js decides when). Sign in and
// sign up are plain links to "/?mode=..." rather than in-page state, so they
// reuse AuthScreen unchanged and the browser's back button returns here.
// Structure only -- every color, font and spacing value comes from the --lp-*
// tokens in landing.css, so a reskin never needs to touch this file.
export default function LandingPage() {
  return (
    <div className="landing" data-testid="landing-page">
      <header className="landing-topbar">
        <a className="landing-wordmark" href="/">Flowuality</a>
        <nav className="landing-auth-links" aria-label="Account">
          <a className="landing-link" href="/?mode=signin" data-testid="landing-sign-in">Sign in</a>
          <a className="landing-button landing-button-secondary" href="/?mode=signup" data-testid="landing-sign-up">Sign up</a>
        </nav>
      </header>

      <main>
        <section className="landing-hero">
          <h1 className="landing-headline">Your to-do list, flowed into the time you actually have.</h1>
          <p className="landing-subhead">
            Flowuality schedules your tasks around your calendar, and around everyone else's.
          </p>
          <div className="landing-cta-row">
            <a className="landing-button landing-button-primary" href="/demo" data-testid="landing-try-demo">Try the demo</a>
            <span className="landing-cta-note">No account needed</span>
          </div>
        </section>

        <div className="landing-reveals">
          {heroSections.map((section) => (
            <RevealSection key={section.id} section={section} />
          ))}
        </div>

        <section className="landing-closing">
          <h2 className="landing-closing-title">See it on your own schedule.</h2>
          <div className="landing-cta-row landing-cta-row-center">
            <a className="landing-button landing-button-primary" href="/demo">Try the demo</a>
            <a className="landing-button landing-button-secondary" href="/?mode=signup">Create an account</a>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <span>Flowuality</span>
        <a className="landing-link" href="/?mode=signin">Sign in</a>
      </footer>
    </div>
  );
}
