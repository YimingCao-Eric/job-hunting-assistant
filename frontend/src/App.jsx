import { Routes, Route, Navigate } from 'react-router-dom'
import ConfigPage from './pages/ConfigPage'
import ProfilePage from './pages/ProfilePage'
import JobsPage from './pages/JobsPage'
import LogsPage from './pages/LogsPage'
import SkillsPage from './pages/SkillsPage'
import MatchingPage from './pages/MatchingPage'
import DedupPage from './pages/DedupPage'
import AutoScrapePage from './app/(dashboard)/auto-scrape/page.tsx'
import { Sidebar } from './components/layout/Sidebar'
import './App.css'

export default function App() {
  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <Routes>
          <Route path="/" element={<ConfigPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/jobs" element={<JobsPage />} />
          <Route path="/logs" element={<LogsPage />} />
          <Route path="/skills" element={<SkillsPage />} />
          <Route path="/search-report" element={<Navigate to="/logs" replace />} />
          <Route path="/matching" element={<MatchingPage />} />
          <Route path="/dashboard/auto-scrape" element={<AutoScrapePage />} />
          <Route path="/dedup" element={<DedupPage />} />
          <Route path="/dedup/passed" element={<Navigate to="/matching" replace />} />
          <Route path="/dedup/removed" element={<Navigate to="/matching" replace />} />
        </Routes>
      </main>
    </div>
  )
}
