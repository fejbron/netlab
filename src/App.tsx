import { Link, Route, Routes } from 'react-router-dom';
import DashboardPage from './pages/DashboardPage';
import LabPage from './pages/LabPage';

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
    <Routes>
      <Route path="/" element={<DashboardPage />} />
      <Route path="/lab/:labId" element={<LabPage />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
