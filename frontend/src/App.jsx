import { Routes, Route, NavLink, Navigate } from 'react-router-dom'
import ConfigPage from './pages/ConfigPage'
import JobsPage from './pages/JobsPage'
import LogsPage from './pages/LogsPage'
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
        <NavLink to="/jobs" className={({isActive}) => isActive ? 'nav-link active' : 'nav-link'}>
          Jobs
        </NavLink>
        <NavLink to="/logs" className={({isActive}) => isActive ? 'nav-link active' : 'nav-link'}>
          Logs
        </NavLink>
        <NavLink to="/dedup" className={({isActive}) => isActive ? 'nav-link active' : 'nav-link'}>
          Dedup
        </NavLink>
      </nav>
      <main className="main">
        <Routes>
          <Route path="/" element={<ConfigPage />} />
          <Route path="/jobs" element={<JobsPage />} />
          <Route path="/logs" element={<LogsPage />} />
          <Route path="/search-report" element={<Navigate to="/logs" replace />} />
          <Route path="/dedup" element={<DedupPage />} />
          <Route path="/dedup/passed" element={<Navigate to="/dedup" replace />} />
          <Route path="/dedup/removed" element={<Navigate to="/dedup" replace />} />
        </Routes>
      </main>
    </div>
  )
}
