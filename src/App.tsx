import { Link, Route, Routes } from 'react-router-dom';
import AccountPage from './pages/AccountPage';
import DashboardPage, { PathRoute } from './pages/DashboardPage';
import LabPage from './pages/LabPage';
import LeaderboardPage from './pages/LeaderboardPage';
import { AuthProvider } from './lib/auth';
import { ProgressProvider } from './lib/progressStore';

function NotFound() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3">
      <h1 className="text-xl font-semibold text-fg-bright">Page not found</h1>
      <Link to="/" className="text-accent hover:underline">
        Back to the lab list
      </Link>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ProgressProvider>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/paths/:pathId" element={<PathRoute />} />
          <Route path="/lab/:labId" element={<LabPage />} />
          <Route path="/account" element={<AccountPage />} />
          <Route path="/leaderboard" element={<LeaderboardPage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </ProgressProvider>
    </AuthProvider>
  );
}
