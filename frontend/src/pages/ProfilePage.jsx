import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import Spinner from '../components/Spinner'
import s from './ProfilePage.module.css'

function emptyEducation() {
  return {
    degree: '',
    field: '',
    institution: '',
    location: '',
    start_date: '',
    end_date: '',
    gpa: '',
    remark: '',
  }
}

function emptyWork() {
  return {
    title: '',
    company: '',
    location: '',
    start_date: '',
    end_date: '',
    description: '',
    skills: [],
  }
}

function emptyProject() {
  return {
    name: '',
    description: '',
    date: '',
    url: '',
    skills: [],
  }
}

function emptyOther() {
  return { category: '', description: '' }
}

function normalizeEducationRow(e) {
  return {
    degree: e?.degree ?? '',
    field: e?.field ?? '',
    institution: e?.institution ?? '',
    location: e?.location ?? '',
    start_date: e?.start_date ?? '',
    end_date: e?.end_date ?? '',
    gpa: e?.gpa ?? '',
    remark: e?.remark ?? '',
  }
}

function normalizeWorkRow(w) {
  return {
    title: w?.title ?? '',
    company: w?.company ?? '',
    location: w?.location ?? '',
    start_date: w?.start_date ?? '',
    end_date: w?.end_date ?? '',
    description: w?.description ?? '',
    skills: Array.isArray(w?.skills) ? w.skills : [],
  }
}

function normalizeProjectRow(p) {
  return {
    name: p?.name ?? '',
    description: p?.description ?? '',
    date: p?.date ?? '',
    url: p?.url ?? '',
    skills: Array.isArray(p?.skills) ? p.skills : [],
  }
}

function mergeParsedIntoProfile(current, parsed) {
  if (!current || !parsed) return current
  const next = { ...current }
  const pe = parsed.personal || {}
  const mergedP = { ...(next.personal || {}) }
  for (const key of ['name', 'email', 'phone', 'location']) {
    const incoming = pe[key]
    if (incoming == null || !String(incoming).trim()) continue
    const cur = mergedP[key]
    if (cur == null || (typeof cur === 'string' && !String(cur).trim())) {
      mergedP[key] = String(incoming).trim()
    }
  }
  if (Array.isArray(pe.urls) && pe.urls.length > 0) {
    const urls = [...(mergedP.urls || [])]
    for (const u of pe.urls) {
      const uu = String(u).trim()
      if (uu && !urls.includes(uu)) urls.push(uu)
    }
    mergedP.urls = urls
  }
  next.personal = mergedP

  if (parsed.education?.length > 0) {
    next.education = parsed.education.map(normalizeEducationRow)
  }
  if (parsed.work_experience?.length > 0) {
    next.work_experience = parsed.work_experience.map(normalizeWorkRow)
  }
  if (parsed.projects?.length > 0) {
    next.projects = parsed.projects.map(normalizeProjectRow)
  }
  return next
}

export default function ProfilePage() {
  const [profile, setProfile] = useState(null)
  const [activeTab, setActiveTab] = useState('personal')
  const [saving, setSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState(null)
  const [saveError, setSaveError] = useState(null)
  const [extracted, setExtracted] = useState(null)
  const [loading, setLoading] = useState(true)
  const [validationError, setValidationError] = useState(null)
  const [fieldErrors, setFieldErrors] = useState(
    /** @type {{ name?: boolean, email?: boolean, location?: boolean }} */ ({})
  )
  const [urlInput, setUrlInput] = useState('')
  const [skillInput, setSkillInput] = useState('')
  const [extraSkills, setExtraSkills] = useState([])

  const resumeInputRef = useRef(null)
  const [resumeUploading, setResumeUploading] = useState(false)
  const [resumeParsing, setResumeParsing] = useState(false)
  const [resumeMarkdown, setResumeMarkdown] = useState(null)
  const [resumeCharCount, setResumeCharCount] = useState(0)
  const [resumeFilename, setResumeFilename] = useState(null)
  const [resumeError, setResumeError] = useState(null)
  const [resumeStep, setResumeStep] = useState('idle')
  const [showMarkdownPreview, setShowMarkdownPreview] = useState(false)
  const [prefilledSections, setPrefilledSections] = useState({
    personal: false,
    education: false,
    experience: false,
    projects: false,
  })

  useEffect(() => {
    loadProfile()
  }, [])

  async function loadProfile() {
    setLoading(true)
    setValidationError(null)
    try {
      const data = await api.getProfile()
      setProfile(data)
      setExtracted(data._extracted ?? null)
      setExtraSkills(Array.isArray(data.extra_skills) ? data.extra_skills : [])
    } catch (e) {
      setValidationError(e instanceof Error ? e.message : 'Failed to load profile')
    } finally {
      setLoading(false)
    }
  }

  async function handleSave() {
    if (!profile) return
    setValidationError(null)
    setFieldErrors({})

    if (!profile.education || profile.education.length < 1) {
      setValidationError('At least one education entry is required.')
      return
    }

    const pe = profile.personal || {}
    const miss = {}
    if (!String(pe.name || '').trim()) miss.name = true
    if (!String(pe.email || '').trim()) miss.email = true
    if (!String(pe.location || '').trim()) miss.location = true
    if (Object.keys(miss).length) {
      setFieldErrors(miss)
      setValidationError('Please fill in all required fields.')
      return
    }

    setSaving(true)
    setSaveStatus('saving')
    setSaveError(null)
    try {
      const payload = {
        personal: profile.personal,
        education: profile.education,
        work_experience: profile.work_experience || [],
        projects: profile.projects || [],
        other: profile.other || [],
        extra_skills: extraSkills,
      }
      const result = await api.saveProfile(payload)
      setProfile(result)
      setExtracted(result._extracted ?? null)
      setExtraSkills(Array.isArray(result.extra_skills) ? result.extra_skills : [])
      setSaveStatus('saved')
      setTimeout(() => setSaveStatus(null), 2000)
    } catch (err) {
      setSaveStatus('error')
      setSaveError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  function updatePersonal(field, value) {
    setProfile((p) =>
      p
        ? {
            ...p,
            personal: { ...p.personal, [field]: value },
          }
        : p
    )
  }

  function resetResumeFlow() {
    setResumeMarkdown(null)
    setResumeCharCount(0)
    setResumeFilename(null)
    setResumeError(null)
    setResumeStep('idle')
    setShowMarkdownPreview(false)
    setResumeUploading(false)
    setResumeParsing(false)
    setPrefilledSections({
      personal: false,
      education: false,
      experience: false,
      projects: false,
    })
    if (resumeInputRef.current) resumeInputRef.current.value = ''
  }

  async function handleResumeUpload(file) {
    if (
      !file ||
      (!file.type?.includes('pdf') && !file.name?.toLowerCase().endsWith('.pdf'))
    ) {
      setResumeError('Please select a PDF file')
      return
    }
    if (file.size > 10 * 1024 * 1024) {
      setResumeError('File too large (max 10MB)')
      return
    }
    setResumeStep('uploading')
    setResumeUploading(true)
    setResumeError(null)
    try {
      const result = await api.uploadResume(file)
      setResumeMarkdown(result.markdown)
      setResumeCharCount(result.char_count ?? (result.markdown ? result.markdown.length : 0))
      setResumeFilename(result.filename ?? file.name)
      setResumeStep('preview')
    } catch (err) {
      setResumeError(err instanceof Error ? err.message : 'PDF extraction failed')
      setResumeStep('idle')
    } finally {
      setResumeUploading(false)
    }
  }

  async function handleResumeParse() {
    if (!resumeMarkdown) return
    setResumeStep('parsing')
    setResumeParsing(true)
    setResumeError(null)
    try {
      const parsed = await api.parseResume(resumeMarkdown)
      setProfile((prev) => mergeParsedIntoProfile(prev, parsed))
      setPrefilledSections({
        personal: !!(
          parsed.personal &&
          (
            (parsed.personal.name && String(parsed.personal.name).trim()) ||
            (parsed.personal.email && String(parsed.personal.email).trim()) ||
            (parsed.personal.phone && String(parsed.personal.phone).trim()) ||
            (parsed.personal.location && String(parsed.personal.location).trim())
          )
        ),
        education: (parsed.education?.length ?? 0) > 0,
        experience: (parsed.work_experience?.length ?? 0) > 0,
        projects: (parsed.projects?.length ?? 0) > 0,
      })
      setResumeStep('done')
    } catch (err) {
      setResumeError(
        err instanceof Error
          ? err.message
          : 'Could not parse resume — please enter fields manually'
      )
      setResumeStep('preview')
    } finally {
      setResumeParsing(false)
    }
  }

  function handleAddSkill() {
    const trimmed = skillInput.trim()
    if (!trimmed) return
    const inExtra = extraSkills.some((x) => x.toLowerCase() === trimmed.toLowerCase())
    const inExtracted = (extracted?.skills || []).some(
      (x) => String(x).toLowerCase() === trimmed.toLowerCase()
    )
    if (inExtra || inExtracted) {
      setSkillInput('')
      return
    }
    setExtraSkills((prev) => [...prev, trimmed])
    setSkillInput('')
  }

  function handleRemoveSkill(skill) {
    setExtraSkills((prev) => prev.filter((s) => s !== skill))
  }

  function handleSkillKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleAddSkill()
    }
  }

  function addUrl() {
    const v = urlInput.trim()
    if (!v) return
    const urls = [...(profile?.personal?.urls || [])]
    if (urls.includes(v)) return
    urls.push(v)
    updatePersonal('urls', urls)
    setUrlInput('')
  }

  function removeUrl(u) {
    const urls = (profile?.personal?.urls || []).filter((x) => x !== u)
    updatePersonal('urls', urls)
  }

  function renderPersonal() {
    if (!profile) return null
    const pe = profile.personal || {}
    return (
      <div>
        <div className={s.field}>
          <label className={s.label}>
            Name <span style={{ color: 'red' }}>*</span>
          </label>
          <input
            className={`${s.input} ${fieldErrors.name ? s.inputError : ''}`}
            value={pe.name || ''}
            onChange={(e) => updatePersonal('name', e.target.value)}
          />
        </div>
        <div className={s.field}>
          <label className={s.label}>
            Email <span style={{ color: 'red' }}>*</span>
          </label>
          <input
            type="email"
            className={`${s.input} ${fieldErrors.email ? s.inputError : ''}`}
            value={pe.email || ''}
            onChange={(e) => updatePersonal('email', e.target.value)}
          />
        </div>
        <div className={s.field}>
          <label className={s.label}>Phone</label>
          <input
            className={s.input}
            value={pe.phone ?? ''}
            onChange={(e) => updatePersonal('phone', e.target.value || null)}
          />
        </div>
        <div className={s.field}>
          <label className={s.label}>
            Location <span style={{ color: 'red' }}>*</span>
          </label>
          <input
            className={`${s.input} ${fieldErrors.location ? s.inputError : ''}`}
            value={pe.location || ''}
            onChange={(e) => updatePersonal('location', e.target.value)}
          />
        </div>
        <div className={s.field}>
          <label className={s.label}>URLs</label>
          <input
            className={s.input}
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addUrl()
              }
            }}
            placeholder="Type URL and press Enter"
          />
          <div className={s.urlTagList}>
            {(pe.urls || []).map((u) => (
              <span key={u} className={s.urlTag}>
                {u}
                <button type="button" className={s.tagRemove} onClick={() => removeUrl(u)} aria-label={`Remove ${u}`}>
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
      </div>
    )
  }

  function renderEducation() {
    if (!profile) return null
    const list = profile.education || []
    const updateEntry = (i, field, value) => {
      setProfile((p) => {
        if (!p) return p
        const next = [...(p.education || [])]
        next[i] = { ...next[i], [field]: value }
        return { ...p, education: next }
      })
    }
    const removeEntry = (i) => {
      setProfile((p) => {
        if (!p) return p
        const next = (p.education || []).filter((_, j) => j !== i)
        return { ...p, education: next }
      })
    }
    return (
      <div>
        {list.length === 0 ? (
          <p className={s.emptyState}>No education entries yet.</p>
        ) : (
          list.map((entry, i) => (
            <div key={i} className={s.entryCard}>
              <div className={s.entryCardHeader}>
                <span className={s.entryCardTitle}>Education #{i + 1}</span>
                {list.length > 1 && (
                  <button type="button" className={s.removeBtn} onClick={() => removeEntry(i)}>
                    Remove
                  </button>
                )}
              </div>
              <div className={s.twoCol}>
                <div className={s.field}>
                  <label className={s.label}>Degree</label>
                  <input className={s.input} value={entry.degree || ''} onChange={(e) => updateEntry(i, 'degree', e.target.value)} />
                </div>
                <div className={s.field}>
                  <label className={s.label}>Field</label>
                  <input className={s.input} value={entry.field || ''} onChange={(e) => updateEntry(i, 'field', e.target.value)} />
                </div>
              </div>
              <div className={s.twoCol}>
                <div className={s.field}>
                  <label className={s.label}>Institution</label>
                  <input
                    className={s.input}
                    value={entry.institution || ''}
                    onChange={(e) => updateEntry(i, 'institution', e.target.value)}
                  />
                </div>
                <div className={s.field}>
                  <label className={s.label}>Location</label>
                  <input className={s.input} value={entry.location || ''} onChange={(e) => updateEntry(i, 'location', e.target.value)} />
                </div>
              </div>
              <div className={s.twoCol}>
                <div className={s.field}>
                  <label className={s.label}>Start (YYYY-MM)</label>
                  <input
                    className={s.input}
                    value={entry.start_date || ''}
                    onChange={(e) => updateEntry(i, 'start_date', e.target.value)}
                  />
                </div>
                <div className={s.field}>
                  <label className={s.label}>End (YYYY-MM)</label>
                  <input
                    className={s.input}
                    value={entry.end_date || ''}
                    onChange={(e) => updateEntry(i, 'end_date', e.target.value)}
                  />
                </div>
              </div>
              <div className={s.field}>
                <label className={s.label}>GPA</label>
                <input className={s.input} value={entry.gpa || ''} onChange={(e) => updateEntry(i, 'gpa', e.target.value)} />
              </div>
              <div className={s.field}>
                <label className={s.label}>Remark</label>
                <textarea className={s.textarea} value={entry.remark || ''} onChange={(e) => updateEntry(i, 'remark', e.target.value)} />
              </div>
            </div>
          ))
        )}
        <button
          type="button"
          className={s.addBtn}
          onClick={() =>
            setProfile((p) =>
              p ? { ...p, education: [...(p.education || []), emptyEducation()] } : p
            )
          }
        >
          + Add Education
        </button>
      </div>
    )
  }

  function renderExperience() {
    if (!profile) return null
    const list = profile.work_experience || []
    const updateEntry = (i, field, value) => {
      setProfile((p) => {
        if (!p) return p
        const next = [...(p.work_experience || [])]
        next[i] = { ...next[i], [field]: value }
        return { ...p, work_experience: next }
      })
    }
    const removeEntry = (i) => {
      setProfile((p) => {
        if (!p) return p
        const next = (p.work_experience || []).filter((_, j) => j !== i)
        return { ...p, work_experience: next }
      })
    }
    const modeLabel = extracted?.extraction_mode || 'CPU'
    return (
      <div>
        {list.length === 0 ? (
          <p className={s.emptyState}>No work experience yet.</p>
        ) : (
          list.map((entry, i) => (
            <div key={i} className={s.entryCard}>
              <div className={s.entryCardHeader}>
                <span className={s.entryCardTitle}>Experience #{i + 1}</span>
                <button type="button" className={s.removeBtn} onClick={() => removeEntry(i)}>
                  Remove
                </button>
              </div>
              <div className={s.twoCol}>
                <div className={s.field}>
                  <label className={s.label}>Title</label>
                  <input className={s.input} value={entry.title || ''} onChange={(e) => updateEntry(i, 'title', e.target.value)} />
                </div>
                <div className={s.field}>
                  <label className={s.label}>Company</label>
                  <input className={s.input} value={entry.company || ''} onChange={(e) => updateEntry(i, 'company', e.target.value)} />
                </div>
              </div>
              <div className={s.field}>
                <label className={s.label}>Location</label>
                <input className={s.input} value={entry.location || ''} onChange={(e) => updateEntry(i, 'location', e.target.value)} />
              </div>
              <div className={s.twoCol}>
                <div className={s.field}>
                  <label className={s.label}>Start (YYYY-MM)</label>
                  <input
                    className={s.input}
                    value={entry.start_date || ''}
                    onChange={(e) => updateEntry(i, 'start_date', e.target.value)}
                  />
                </div>
                <div className={s.field}>
                  <label className={s.label}>End (YYYY-MM)</label>
                  <input
                    className={s.input}
                    value={entry.end_date || ''}
                    onChange={(e) => updateEntry(i, 'end_date', e.target.value)}
                  />
                </div>
              </div>
              <div className={s.field}>
                <label className={s.label}>Description</label>
                <textarea
                  className={s.textarea}
                  value={entry.description || ''}
                  onChange={(e) => updateEntry(i, 'description', e.target.value)}
                />
              </div>
              <div className={s.extractedSkillsSection}>
                <span className={s.extractedSkillsLabel}>Extracted skills</span>
                {entry.skills && entry.skills.length > 0 ? (
                  <>
                    <div className={s.skillTagList}>
                      {entry.skills.map((sk) => (
                        <span key={sk} className={s.skillTag}>
                          {sk}
                        </span>
                      ))}
                    </div>
                    <span className={s.extractedMeta}>
                      Extracted on save · {modeLabel}
                    </span>
                  </>
                ) : (
                  <span className={s.extractedMeta}>Skills will be extracted when you save.</span>
                )}
              </div>
            </div>
          ))
        )}
        <button
          type="button"
          className={s.addBtn}
          onClick={() =>
            setProfile((p) =>
              p ? { ...p, work_experience: [...(p.work_experience || []), emptyWork()] } : p
            )
          }
        >
          + Add Experience
        </button>
      </div>
    )
  }

  function renderProjects() {
    if (!profile) return null
    const list = profile.projects || []
    const updateEntry = (i, field, value) => {
      setProfile((p) => {
        if (!p) return p
        const next = [...(p.projects || [])]
        next[i] = { ...next[i], [field]: value }
        return { ...p, projects: next }
      })
    }
    const removeEntry = (i) => {
      setProfile((p) => {
        if (!p) return p
        const next = (p.projects || []).filter((_, j) => j !== i)
        return { ...p, projects: next }
      })
    }
    const modeLabel = extracted?.extraction_mode || 'CPU'
    return (
      <div>
        {list.length === 0 ? (
          <p className={s.emptyState}>No projects yet.</p>
        ) : (
          list.map((entry, i) => (
            <div key={i} className={s.entryCard}>
              <div className={s.entryCardHeader}>
                <span className={s.entryCardTitle}>Project #{i + 1}</span>
                <button type="button" className={s.removeBtn} onClick={() => removeEntry(i)}>
                  Remove
                </button>
              </div>
              <div className={s.twoCol}>
                <div className={s.field}>
                  <label className={s.label}>Name</label>
                  <input className={s.input} value={entry.name || ''} onChange={(e) => updateEntry(i, 'name', e.target.value)} />
                </div>
                <div className={s.field}>
                  <label className={s.label}>Date (YYYY-MM)</label>
                  <input className={s.input} value={entry.date || ''} onChange={(e) => updateEntry(i, 'date', e.target.value)} />
                </div>
              </div>
              <div className={s.field}>
                <label className={s.label}>Description</label>
                <textarea
                  className={s.textarea}
                  value={entry.description || ''}
                  onChange={(e) => updateEntry(i, 'description', e.target.value)}
                />
              </div>
              <div className={s.field}>
                <label className={s.label}>URL</label>
                <input className={s.input} value={entry.url || ''} onChange={(e) => updateEntry(i, 'url', e.target.value)} />
              </div>
              <div className={s.extractedSkillsSection}>
                <span className={s.extractedSkillsLabel}>Extracted skills</span>
                {entry.skills && entry.skills.length > 0 ? (
                  <>
                    <div className={s.skillTagList}>
                      {entry.skills.map((sk) => (
                        <span key={sk} className={s.skillTag}>
                          {sk}
                        </span>
                      ))}
                    </div>
                    <span className={s.extractedMeta}>
                      Extracted on save · {modeLabel}
                    </span>
                  </>
                ) : (
                  <span className={s.extractedMeta}>Skills will be extracted when you save.</span>
                )}
              </div>
            </div>
          ))
        )}
        <button
          type="button"
          className={s.addBtn}
          onClick={() =>
            setProfile((p) => (p ? { ...p, projects: [...(p.projects || []), emptyProject()] } : p))
          }
        >
          + Add Project
        </button>
      </div>
    )
  }

  function renderOther() {
    if (!profile) return null
    const list = profile.other || []
    const updateEntry = (i, field, value) => {
      setProfile((p) => {
        if (!p) return p
        const next = [...(p.other || [])]
        next[i] = { ...next[i], [field]: value }
        return { ...p, other: next }
      })
    }
    const removeEntry = (i) => {
      setProfile((p) => {
        if (!p) return p
        const next = (p.other || []).filter((_, j) => j !== i)
        return { ...p, other: next }
      })
    }
    return (
      <div>
        {list.length === 0 ? (
          <p className={s.emptyState}>No other entries yet.</p>
        ) : (
          list.map((entry, i) => (
            <div key={i} className={s.entryCard}>
              <div className={s.entryCardHeader}>
                <span className={s.entryCardTitle}>Other #{i + 1}</span>
                <button type="button" className={s.removeBtn} onClick={() => removeEntry(i)}>
                  Remove
                </button>
              </div>
              <div className={s.field}>
                <label className={s.label}>Category</label>
                <input className={s.input} value={entry.category || ''} onChange={(e) => updateEntry(i, 'category', e.target.value)} />
              </div>
              <div className={s.field}>
                <label className={s.label}>Description</label>
                <textarea
                  className={s.textarea}
                  value={entry.description || ''}
                  onChange={(e) => updateEntry(i, 'description', e.target.value)}
                />
              </div>
            </div>
          ))
        )}
        <button
          type="button"
          className={s.addBtn}
          onClick={() =>
            setProfile((p) => (p ? { ...p, other: [...(p.other || []), emptyOther()] } : p))
          }
        >
          + Add Other
        </button>
      </div>
    )
  }

  function renderExtractedPanel() {
    const extraLower = new Set(extraSkills.map((x) => String(x).toLowerCase()))
    const detectedFromResume = (extracted?.skills || []).filter(
      (sk) => !extraLower.has(String(sk).toLowerCase())
    )
    const totalSkillCount = extracted?.skills?.length ?? 0

    return (
      <div className={s.extractedPanel}>
        {extracted && extracted.yoe != null ? (
          <>
            <div className={s.extractedMeta}>
              <span>YOE: {extracted.yoe} years</span>
              <span> · </span>
              <span>Skills: {totalSkillCount} total</span>
              <span> · </span>
              <span
                className={
                  extracted.extraction_mode === 'llm' || extracted.extraction_mode === 'llm_partial'
                    ? s.extractedModeLlm
                    : s.extractedModeCpu
                }
              >
                Mode: {(extracted.extraction_mode || 'cpu').toUpperCase()}
              </span>
            </div>
            {extracted.extracted_at && (
              <div className={s.extractedMeta} style={{ marginTop: 6 }}>
                Last extracted: {new Date(extracted.extracted_at).toLocaleString()}
              </div>
            )}
          </>
        ) : (
          <div className={s.extractedMeta}>
            No profile extraction yet — fill in your details and save to compute YOE and
            auto-detected skills.
            {totalSkillCount > 0 && (
              <>
                {' '}
                Current skill list: {totalSkillCount} (includes any manual skills after save).
              </>
            )}
          </div>
        )}

        {detectedFromResume.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div className={s.skillSectionLabel}>Detected from resume</div>
            <div className={s.urlTagList}>
              {detectedFromResume.map((skill) => (
                <span key={skill} className={s.skillTagReadOnly}>
                  {skill}
                </span>
              ))}
            </div>
          </div>
        )}

        <div style={{ marginTop: 14 }}>
          <div className={s.skillSectionLabel}>Additional skills</div>
          <div className={s.urlTagList}>
            {extraSkills.map((skill) => (
              <span key={skill} className={s.urlTag}>
                {skill}
                <button
                  type="button"
                  className={s.tagRemove}
                  onClick={() => handleRemoveSkill(skill)}
                  aria-label={`Remove ${skill}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <div className={s.skillInputRow}>
            <input
              className={s.skillInput}
              type="text"
              placeholder="e.g. JavaScript, Git, PostgreSQL"
              value={skillInput}
              onChange={(e) => setSkillInput(e.target.value)}
              onKeyDown={handleSkillKeyDown}
            />
            <button
              type="button"
              className={s.skillAddBtn}
              onClick={handleAddSkill}
              disabled={!skillInput.trim()}
            >
              + Add
            </button>
          </div>
          <div className={s.skillHint}>
            Add skills you know that weren&apos;t detected from your resume. Press Enter or click
            + Add.
          </div>
        </div>
      </div>
    )
  }

  const saveClass =
    saveStatus === 'saved'
      ? `${s.saveBtn} ${s.saveBtnSaved}`
      : saveStatus === 'error'
        ? `${s.saveBtn} ${s.saveBtnError}`
        : s.saveBtn

  const resumeMdPreview =
    resumeMarkdown && resumeMarkdown.length > 800
      ? `${resumeMarkdown.slice(0, 800)}…`
      : resumeMarkdown || ''

  const resumeBusy = loading || saving || resumeUploading || resumeParsing

  return (
    <div>
      <div className={s.pageHeader}>
        <h1>Profile</h1>
        <button type="button" className={saveClass} onClick={handleSave} disabled={saving || loading}>
          {saveStatus === 'saving' || saving
            ? 'Saving…'
            : saveStatus === 'saved'
              ? 'Saved ✓'
              : saveStatus === 'error'
                ? 'Save failed'
                : 'Save'}
        </button>
      </div>

      {!loading && profile && (
        <div className={s.resumeUploadBox}>
          <div className={s.resumeUploadTitle}>📎 Upload Resume PDF</div>
          {resumeStep === 'idle' && (
            <>
              <input
                ref={resumeInputRef}
                id="resume-pdf-input"
                type="file"
                accept=".pdf,application/pdf"
                className={s.resumeFileInputHidden}
                disabled={resumeBusy}
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) handleResumeUpload(f)
                }}
              />
              <label htmlFor="resume-pdf-input" className={s.resumeChooseBtn}>
                Choose PDF file
              </label>
              <p className={s.resumeHint}>Upload your resume to auto-fill profile fields</p>
            </>
          )}
          {resumeStep === 'uploading' && (
            <p className={s.resumeStatus}>{'\u23f3'} Extracting PDF…</p>
          )}
          {resumeStep === 'preview' && (
            <div className={s.resumePreviewBlock}>
              <p className={s.resumeSuccess}>
                {'\u2713'} Extracted {resumeCharCount} characters from {resumeFilename || 'file'}
              </p>
              <button
                type="button"
                className={s.resumeToggleBtn}
                onClick={() => setShowMarkdownPreview((v) => !v)}
              >
                {showMarkdownPreview ? '\u25bc Hide extracted text' : '\u25b6 Show extracted text'}
              </button>
              {showMarkdownPreview && (
                <pre className={s.resumeMarkdownPre}>{resumeMdPreview}</pre>
              )}
              <div className={s.resumePreviewActions}>
                <button
                  type="button"
                  className={s.resumeParseBtn}
                  onClick={handleResumeParse}
                  disabled={resumeParsing || !resumeMarkdown}
                >
                  {'\u2192'} Parse into profile fields
                </button>
                <button
                  type="button"
                  className={s.resumeCancelBtn}
                  onClick={resetResumeFlow}
                  disabled={resumeParsing}
                >
                  {'\u2715'} Cancel
                </button>
              </div>
            </div>
          )}
          {resumeStep === 'parsing' && (
            <p className={s.resumeStatus}>{'\u23f3'} Parsing fields…</p>
          )}
          {resumeStep === 'done' && (
            <div>
              <p className={s.resumeSuccess}>
                {'\u2713'} Profile fields pre-filled — review below and save
              </p>
              <button type="button" className={s.resumeLinkBtn} onClick={resetResumeFlow}>
                Upload different resume
              </button>
            </div>
          )}
          {resumeError && (
            <p className={s.resumeError} role="alert">
              {'\u26a0'} {resumeError}
            </p>
          )}
        </div>
      )}

      {saveError && <p className={s.validationMsg}>{saveError}</p>}
      {validationError && <p className={s.validationMsg}>{validationError}</p>}
      <div className={s.tabs}>
        {['personal', 'education', 'experience', 'projects', 'other'].map((tab) => (
          <button
            key={tab}
            type="button"
            className={`${s.tab} ${activeTab === tab ? s.tabActive : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>
      {loading ? (
        <div className={s.spinnerWrap}>
          <Spinner />
        </div>
      ) : (
        <>
          {activeTab === 'personal' && (
            <div
              className={prefilledSections.personal ? s.prefilledFromResume : undefined}
            >
              {renderPersonal()}
            </div>
          )}
          {activeTab === 'education' && (
            <div
              className={prefilledSections.education ? s.prefilledFromResume : undefined}
            >
              {renderEducation()}
            </div>
          )}
          {activeTab === 'experience' && (
            <div
              className={prefilledSections.experience ? s.prefilledFromResume : undefined}
            >
              {renderExperience()}
            </div>
          )}
          {activeTab === 'projects' && (
            <div
              className={prefilledSections.projects ? s.prefilledFromResume : undefined}
            >
              {renderProjects()}
            </div>
          )}
          {activeTab === 'other' && renderOther()}
        </>
      )}
      {renderExtractedPanel()}
    </div>
  )
}
