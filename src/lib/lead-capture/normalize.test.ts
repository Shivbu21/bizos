import { describe, expect, it } from 'vitest';
import { normalizeLeadPayload } from './normalize';
import {
  extractComments,
  matchKeywordRule,
  renderReplyTemplate,
} from './instagram';

describe('normalizeLeadPayload', () => {
  it('normalizes a Meta leadgen field_data payload', () => {
    const body = {
      entry: [
        {
          changes: [
            {
              value: {
                field_data: [
                  { name: 'full_name', values: ['Asha Verma'] },
                  { name: 'phone_number', values: ['+91 98765 43210'] },
                  { name: 'email', values: ['asha@example.com'] },
                ],
              },
            },
          ],
        },
      ],
    };
    const lead = normalizeLeadPayload('facebook_lead_ads', body);
    expect(lead.name).toBe('Asha Verma');
    expect(lead.phone).toBe('+91 98765 43210');
    expect(lead.email).toBe('asha@example.com');
  });

  it('falls back to first+last name when full_name is absent', () => {
    const body = {
      entry: [{ changes: [{ value: { field_data: [
        { name: 'first_name', values: ['Asha'] },
        { name: 'last_name', values: ['Verma'] },
      ] } }] }],
    };
    expect(normalizeLeadPayload('facebook_lead_ads', body).name).toBe('Asha Verma');
  });

  it('normalizes a Justdial-style flat payload case-insensitively', () => {
    const lead = normalizeLeadPayload('justdial', {
      Name: 'Ravi Kumar',
      MOBILE: '9810012345',
      Email: 'ravi@example.com',
      City: 'Delhi',
    });
    expect(lead.name).toBe('Ravi Kumar');
    expect(lead.phone).toBe('9810012345');
    expect(lead.email).toBe('ravi@example.com');
    expect(lead.extra.city).toBe('Delhi');
  });

  it('normalizes a generic web form payload', () => {
    const lead = normalizeLeadPayload('web_form', {
      fullName: 'Meera',
      phoneNumber: '9999988888',
      message: 'Need pricing',
    });
    expect(lead.name).toBe('Meera');
    expect(lead.phone).toBe('9999988888');
    expect(lead.extra.message).toBe('Need pricing');
  });

  it('degrades gracefully on unknown shapes', () => {
    const lead = normalizeLeadPayload('web_form', { foo: 'bar' });
    expect(lead.name).toBeNull();
    expect(lead.phone).toBeNull();
  });

  it('throws on unknown source types', () => {
    expect(() => normalizeLeadPayload('sms' as never, {})).toThrow();
  });
});

describe('extractComments', () => {
  it('extracts comments from a Meta instagram webhook body', () => {
    const body = {
      entry: [
        {
          changes: [
            {
              field: 'comments',
              value: {
                id: 'c1',
                text: 'PRICE please',
                from: { id: 'u1', username: 'buyer_99' },
                media: { id: 'm1' },
              },
            },
            { field: 'likes', value: {} },
          ],
        },
      ],
    };
    const comments = extractComments(body);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      commentId: 'c1',
      text: 'PRICE please',
      fromId: 'u1',
      fromUsername: 'buyer_99',
      mediaId: 'm1',
    });
  });

  it('skips non-comment fields and empty text', () => {
    expect(extractComments({ entry: [{ changes: [{ field: 'comments', value: { text: '' } }] }] })).toHaveLength(0);
    expect(extractComments({})).toHaveLength(0);
  });
});

describe('matchKeywordRule', () => {
  const rules = [
    { id: 'r1', keyword: 'PRICE', reply_template: 't1' },
    { id: 'r2', keyword: 'demo', reply_template: 't2' },
  ];

  it('matches case-insensitively as a substring', () => {
    expect(matchKeywordRule('What is the price?', rules)?.id).toBe('r1');
    expect(matchKeywordRule('PRICE', rules)?.id).toBe('r1');
  });

  it('returns null when nothing matches', () => {
    expect(matchKeywordRule('hello there', rules)).toBeNull();
  });
});

describe('renderReplyTemplate', () => {
  it('substitutes {{name}}', () => {
    expect(renderReplyTemplate('Hi {{name}}!', '@buyer_99')).toBe('Hi @buyer_99!');
  });
});
