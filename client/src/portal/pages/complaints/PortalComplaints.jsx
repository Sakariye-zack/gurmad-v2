import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { DataTable, StatusBadge, EmptyState, Button } from '../../../components/ui/index.js';
import PortalPageHeader from '../../components/PortalPageHeader.jsx';
import { portalApiClient } from '../../apiClient.js';

const STATUS_MAP = { pending: 'warning', in_progress: 'info', resolved: 'success', closed: 'info' };

export default function PortalComplaints() {
  const navigate = useNavigate();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    setError(null);
    portalApiClient.get('/complaints')
      .then((res) => setRows(res.data))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  return (
    <div>
      <PortalPageHeader
        title="My Complaints"
        subtitle="Submit and track your complaints"
        actions={<Button icon={Plus} onClick={() => navigate('/portal/complaints/new')}>New Complaint</Button>}
      />
      <DataTable
        loading={loading}
        error={error}
        onRetry={load}
        columns={[{ label: 'Title' }, { label: 'Priority' }, { label: 'Status' }, { label: 'Date' }]}
        isEmpty={rows && rows.length === 0}
      >
        {rows && rows.length === 0 ? (
          <tr><td colSpan={4}><EmptyState title="No complaints yet" subtitle="Submit a complaint if you have an issue with your service." /></td></tr>
        ) : rows?.map((c) => (
          <tr key={c.id} onClick={() => navigate(`/portal/complaints/${c.id}`)} style={{ borderTop: '1px solid var(--border)', cursor: 'pointer' }}>
            <td style={tdStyle}>{c.title}</td>
            <td style={{ ...tdStyle, textTransform: 'capitalize' }}>{c.priority}</td>
            <td style={tdStyle}><StatusBadge status={c.status} map={STATUS_MAP} /></td>
            <td style={tdStyle}>{new Date(c.created_at).toLocaleDateString()}</td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}

const tdStyle = { padding: '10px 14px' };
