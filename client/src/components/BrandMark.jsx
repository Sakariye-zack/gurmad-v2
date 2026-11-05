import React from 'react';
import CompanyLogo from './CompanyLogo.jsx';
import { useCompanyName } from '../hooks/useSettings.js';

// Sidebar / mobile-drawer brand block. The uploaded logo has its own
// off-white background, which looked like a pasted rectangle on the dark
// sidebar — so it now sits on a white rounded tile, with the company name
// underneath (the sidebar is too narrow to fit both on one line).
export default function BrandMark({ logoHeight = 34 }) {
  const { data } = useCompanyName();
  const companyName = data?.data?.company_name || 'GURMAD V2';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '8px', minWidth: 0 }}>
      <div style={{
        background: '#ffffff', borderRadius: '12px', padding: '7px 12px',
        boxShadow: '0 1px 3px rgba(0,0,0,0.3)', display: 'flex', alignItems: 'center',
      }}>
        <CompanyLogo
          height={logoHeight}
          style={{ maxWidth: '150px' }}
          fallback={<span style={{ fontWeight: 900, fontSize: '18px', color: '#3DAA35', lineHeight: `${logoHeight}px` }}>{companyName}</span>}
        />
      </div>
      <span style={{ fontWeight: 800, fontSize: '14px', letterSpacing: '-0.01em', color: 'var(--text)', paddingLeft: '2px', maxWidth: '100%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {companyName}
      </span>
    </div>
  );
}
