import { NavLink } from "react-router-dom";

const linkCls = ({ isActive }: { isActive: boolean }) =>
  isActive ? "nav-link active" : "nav-link";

export function Sidebar() {
  return (
    <nav className="nav">
      <span className="nav-brand">JHA</span>
      <NavLink to="/" end className={linkCls}>
        Config
      </NavLink>
      <NavLink to="/profile" className={linkCls}>
        Profile
      </NavLink>
      <NavLink to="/jobs" className={linkCls}>
        Jobs
      </NavLink>
      <NavLink to="/logs" className={linkCls}>
        Logs
      </NavLink>
      <NavLink to="/skills" className={linkCls}>
        Skills
      </NavLink>
      <NavLink to="/matching" className={linkCls}>
        Matching
      </NavLink>
      <NavLink to="/dashboard/auto-scrape" className={linkCls}>
        Auto-Scrape
      </NavLink>
    </nav>
  );
}
