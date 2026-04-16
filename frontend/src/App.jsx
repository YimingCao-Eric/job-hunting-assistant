import { Routes, Route, NavLink, Navigate } from 'react-router-dom'
import ConfigPage from './pages/ConfigPage'
import ProfilePage from './pages/ProfilePage'
import JobsPage from './pages/JobsPage'
import LogsPage from './pages/LogsPage'
import SkillsPage from './pages/SkillsPage'
import MatchingPage from './pages/MatchingPage'
import DedupPage from './pages/DedupPage'
import './App.css'

export default function App() {
  return (
    <div className="app">
      <nav className="nav">
        <span className="nav-brand">JHA</span>
        <NavLink to="/" end className={({isActive}) => isActive ? 'nav-link active' : 'nav-link'}>
          Config
        </NavLink>
        <NavLink to="/profile" className={({isActive}) => isActive ? 'nav-link active' : 'nav-link'}>
          Profile
        </NavLink>
        <NavLink to="/jobs" className={({isActive}) => isActive ? 'nav-link active' : 'nav-link'}>
          Jobs
        </NavLink>
        <NavLink to="/logs" className={({isActive}) => isActive ? 'nav-link active' : 'nav-link'}>
          Logs
        </NavLink>
        <NavLink to="/skills" className={({isActive}) => isActive ? 'nav-link active' : 'nav-link'}>
          Skills
        </NavLink>
        <NavLink to="/matching" className={({isActive}) => isActive ? 'nav-link active' : 'nav-link'}>
          Matching
        </NavLink>
      </nav>
      <main className="main">
        <Routes>
          <Route path="/" element={<ConfigPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/jobs" element={<JobsPage />} />
          <Route path="/logs" element={<LogsPage />} />
          <Route path="/skills" element={<SkillsPage />} />
          <Route path="/search-report" element={<Navigate to="/logs" replace />} />
          <Route path="/matching" element={<MatchingPage />} />
          <Route path="/dedup" element={<DedupPage />} />
          <Route path="/dedup/passed" element={<Navigate to="/matching" replace />} />
          <Route path="/dedup/removed" element={<Navigate to="/matching" replace />} />
        </Routes>
      </main>
    </div>
  )
}
