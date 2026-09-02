import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Button, useToast } from '../../../components/ui/index.js';
import PortalPageHeader from '../../components/PortalPageHeader.jsx';
import PortalCard from '../../components/PortalCard.jsx';
import { portalApiClient } from '../../apiClient.js';

export default function PortalComplaintSubmit() {
  const navigate = useNavigate();
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('medium');
  const [photo, setPhoto] = useState(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const formData = new FormData();
      formData.append('title', title);
      formData.append('description', description);
      formData.append('priority', priority);
      if (photo) formData.append('photo', photo);
      const res = await portalApiClient.postForm('/complaints', formData);
      toast.success('Complaint submitted.');
      navigate(`/portal/complaints/${res.data.id}`);
    } catch (err) {
      toast.error(err.message || 'Failed to submit complaint.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <button onClick={() => navigate('/portal/complaints')} style={backLinkStyle}>
        <ArrowLeft size={14} /> Back to Complaints
      </button>
      <PortalPageHeader title="Submit a Complaint" subtitle="Tell us what went wrong" />

      <PortalCard>
        <form onSubmit={handleSubmit} style={{ maxWidth: '480px' }}>
          <label style={labelStyle}>Title</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} style={inputStyle} required maxLength={255} />

          <label style={labelStyle}>Description</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={5} style={{ ...inputStyle, resize: 'vertical' }} required />

          <label style={labelStyle}>Priority</label>
          <select value={priority} onChange={(e) => setPriority(e.target.value)} style={inputStyle}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>

          <label style={labelStyle}>Photo (optional — PDF, JPEG, or PNG, max 10MB)</label>
          <input type="file" accept=".pdf,.jpg,.jpeg,.png" onChange={(e) => setPhoto(e.target.files?.[0] || null)} style={inputStyle} />

          <Button type="submit" disabled={saving || !title.trim() || !description.trim()} style={{ marginTop: '16px' }}>
            {saving ? 'Submitting…' : 'Submit Complaint'}
          </Button>
        </form>
      </PortalCard>
    </div>
  );
}

const backLinkStyle = {
  display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none',
  color: 'var(--text-muted)', fontWeight: 700, fontSize: '12px', cursor: 'pointer', padding: 0, marginBottom: '16px',
};
const labelStyle = { display: 'block', fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginTop: '14px', marginBottom: '6px' };
const inputStyle = { width: '100%', padding: '10px 12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', fontSize: '14px', boxSizing: 'border-box', fontFamily: 'inherit' };
