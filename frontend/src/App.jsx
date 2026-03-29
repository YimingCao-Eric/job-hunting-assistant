import { Routes, Route, NavLink } from 'react-router-dom'
import ConfigPage from './pages/ConfigPage'
import JobsPage from './pages/JobsPage'
import SearchReportPage from './pages/SearchReportPage'
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
        <NavLink to="/search-report" className={({isActive}) => isActive ? 'nav-link active' : 'nav-link'}>
          Search Report
        </NavLink>
      </nav>
      <main className="main">
        <Routes>
          <Route path="/" element={<ConfigPage />} />
          <Route path="/jobs" element={<JobsPage />} />
          <Route path="/search-report" element={<SearchReportPage />} />
        </Routes>
      </main>
    </div>
  )
}
