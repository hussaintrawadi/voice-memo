import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Clock3, CloudOff, Home as HomeIcon, Mic, Sparkles } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { Link, Route, Switch, useLocation, useSearch } from "wouter";
import { RecordSheet } from "./components/RecordSheet";
import { Spinner } from "./components/ui";
import { api, type AuthState } from "./lib/api";
import { useOnline } from "./lib/online";
import { isNativeApp, sessionStore } from "./lib/platform";
import { onUploaded } from "./lib/queue";
import { RecordingProvider, useRecording } from "./lib/recording";
import { refreshDeviceToken } from "./lib/session";
import { Home } from "./pages/Home";
import { ProjectPage } from "./pages/ProjectPage";
import { Projects } from "./pages/Projects";
import { RecordingPage } from "./pages/RecordingPage";
import { Search } from "./pages/Search";
import { Settings } from "./pages/Settings";
import { Summary } from "./pages/Summary";
import { Timeline } from "./pages/Timeline";
import { Welcome } from "./pages/Welcome";

const LEFT = [
  { href: "/", label: "Home", icon: HomeIcon },
  { href: "/timeline", label: "Timeline", icon: Clock3 },
];
const RIGHT = [
  { href: "/projects", label: "Projects", icon: BookOpen },
  { href: "/summary", label: "Summary", icon: Sparkles },
];

function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div
      role="status"
      className="sticky top-0 z-30 flex items-center justify-center gap-2 bg-surface-2 px-4 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] text-xs text-muted"
    >
      <CloudOff className="size-3.5" aria-hidden />
      Offline. Showing saved memos; new recordings upload when you're back.
    </div>
  );
}

function NavLink({ href, label, icon: Icon, active }: { href: string; label: string; icon: typeof HomeIcon; active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`flex flex-1 flex-col items-center gap-0.5 pb-2 pt-2.5 text-[11px] font-medium ${active ? "text-ink" : "text-muted"}`}
    >
      <Icon className="size-5" strokeWidth={active ? 2.25 : 1.75} aria-hidden />
      {label}
    </Link>
  );
}

/** Bottom bar with the record button in the middle, where the thumb rests. */
function BottomBar() {
  const [location] = useLocation();
  const search = useSearch();
  const rec = useRecording();
  const active = (href: string) => (href === "/" ? location === "/" : location.startsWith(href));
  const pulse = new URLSearchParams(search).has("record");

  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
    >
      <div className="mx-auto flex max-w-2xl items-end">
        {LEFT.map((item) => (
          <NavLink key={item.href} {...item} active={active(item.href)} />
        ))}
        <div className="flex flex-1 justify-center">
          <button
            type="button"
            onClick={rec.start}
            disabled={!rec.supported || rec.busy}
            aria-label="Record a memo"
            className="relative -mt-6 mb-1 grid size-16 place-items-center rounded-full bg-accent text-white shadow-lg shadow-accent/30 ring-4 ring-bg transition active:scale-95 disabled:opacity-60"
          >
            {pulse && <span className="pulse-ring absolute inset-0 rounded-full bg-accent" aria-hidden />}
            <Mic className="relative size-7" strokeWidth={2} aria-hidden />
          </button>
        </div>
        {RIGHT.map((item) => (
          <NavLink key={item.href} {...item} active={active(item.href)} />
        ))}
      </div>
    </nav>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <RecordingProvider>
      <div className="min-h-dvh">
        <OfflineBanner />
        <main className="mx-auto max-w-2xl px-4 pb-32 pt-[max(1rem,env(safe-area-inset-top))]">{children}</main>
        <BottomBar />
        <RecordSheet />
      </div>
    </RecordingProvider>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const auth = useQuery({ queryKey: ["auth"], queryFn: () => api<AuthState>("/auth/state"), staleTime: 60_000 });

  useEffect(() => {
    refreshDeviceToken();
    const onUnauthorized = () => {
      if (isNativeApp) sessionStore.set(null);
      void queryClient.invalidateQueries({ queryKey: ["auth"] });
    };
    window.addEventListener("vm:unauthorized", onUnauthorized);
    const off = onUploaded(() => void queryClient.invalidateQueries({ queryKey: ["recordings"] }));
    return () => {
      window.removeEventListener("vm:unauthorized", onUnauthorized);
      off();
    };
  }, [queryClient]);

  // Offline start uses the sign-in state saved in the cache; with nothing saved, say so instead of spinning.
  if (auth.isPending && auth.fetchStatus !== "paused") return <Spinner label="Loading" />;
  if (!auth.data) {
    return (
      <p className="p-6 text-center text-muted">
        Can't reach Voice Memo right now. Connect to the internet once to sign in.
      </p>
    );
  }
  if (!auth.data.user) return <Welcome auth={auth.data} />;

  return (
    <Shell>
      <Switch>
        <Route path="/">{() => <Home userName={auth.data.user?.name ?? ""} />}</Route>
        <Route path="/timeline" component={Timeline} />
        <Route path="/projects" component={Projects} />
        <Route path="/projects/:id">{(params) => <ProjectPage key={params.id} id={params.id} />}</Route>
        <Route path="/summary" component={Summary} />
        <Route path="/search" component={Search} />
        <Route path="/settings" component={Settings} />
        <Route path="/r/:id">{(params) => <RecordingPage key={params.id} id={params.id} />}</Route>
        <Route>
          <p className="py-10 text-center text-muted">Page not found.</p>
        </Route>
      </Switch>
    </Shell>
  );
}
