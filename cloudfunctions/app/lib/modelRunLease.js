const LEASE_MS = 60000

function expired(row, at) {
  if (row?.status !== 'running') return false
  const deadline = row.lease_until ?? ((Number(row.updated_at ?? row.updatedAt ?? row.createdAt) || 0) + LEASE_MS)
  return deadline <= at
}

module.exports = { LEASE_MS, expired }
