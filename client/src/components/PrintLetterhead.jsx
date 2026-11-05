import React from 'react';
import { useCompanyName } from '../hooks/useSettings.js';

// Letterhead shown only when a page is printed / saved as PDF, so every
// printed report carries the company logo and name like the generated
// invoice and cashout documents do.
export default function PrintLetterhead({ title, subtitle }) {
  const { data } = useCompanyName();
  const companyName = data?.data?.company_name || 'GURMAD';
  return (
    <>
      <style>{`
        .print-letterhead { display: none; }
        @media print {
          .print-letterhead { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px;
            padding-bottom: 12px; margin-bottom: 18px; border-bottom: 4px solid #3DAA35; box-shadow: 0 3px 0 #F5A623;
            color: #1B1F16; background: #fff; }
          .print-letterhead img { height: 54px; width: auto; display: block; margin-bottom: 6px; }
          .print-letterhead .pl-name { font-size: 18px; font-weight: 800; }
          .print-letterhead .pl-tag { font-size: 12px; color: #3DAA35; }
          .print-letterhead .pl-doc { text-align: right; }
          .print-letterhead .pl-title { font-size: 22px; font-weight: 800; color: #3DAA35; letter-spacing: .08em; text-transform: uppercase; }
          .print-letterhead .pl-sub { font-size: 12px; color: #6B7280; }
        }
      `}</style>
      <div className="print-letterhead" aria-hidden="true">
        <div>
          <img src="/api/v2/settings/company/logo-trimmed" alt="" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
          <div className="pl-name">{companyName}</div>
          <div className="pl-tag">Shirkadda Nadaafadda</div>
        </div>
        <div className="pl-doc">
          <div className="pl-title">{title}</div>
          {subtitle && <div className="pl-sub">{subtitle}</div>}
          <div className="pl-sub">Printed {new Date().toLocaleString()}</div>
        </div>
      </div>
    </>
  );
}
