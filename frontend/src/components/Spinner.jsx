export default function Spinner() {
  return (
    <div style={{
      width: 20, height: 20,
      border: '2px solid #e5e5e5',
      borderTop: '2px solid #111',
      borderRadius: '50%',
      animation: 'spin 0.7s linear infinite',
      display: 'inline-block'
    }} />
  )
}
