import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  normalizeHeader,
  createHeaderTransformer,
  parseCsv,
  BUDGET_ITEM_DELETE_ALIASES,
  BUDGET_ITEM_SET_ALIASES,
  USER_DELETE_ALIASES,
  USER_REMOVE_PROJECT_ROLE_ALIASES,
  USER_REMOVE_PROJECT_ALIASES,
  USER_SET_SSO_ALIASES,
  USER_SET_FIELD_ALIASES,
} from '../lib/csv.js';

describe('CSV Header Normalization & Parsing', () => {
  describe('normalizeHeader', () => {
    it('normalizes various casing, spaces, and punctuation', () => {
      assert.strictEqual(normalizeHeader('userName'), 'username');
      assert.strictEqual(normalizeHeader('User Name'), 'username');
      assert.strictEqual(normalizeHeader('user name'), 'username');
      assert.strictEqual(normalizeHeader('user_name'), 'username');
      assert.strictEqual(normalizeHeader('user-name'), 'username');
      assert.strictEqual(normalizeHeader(' USER_NAME '), 'username');
      assert.strictEqual(normalizeHeader('Single Sign-On'), 'singlesignon');
      assert.strictEqual(normalizeHeader('Allow Charges?'), 'allowcharges');
      assert.strictEqual(
        normalizeHeader('Approval-Required_For.Change!'),
        'approvalrequiredforchange',
      );
    });
  });

  describe('createHeaderTransformer', () => {
    it('maps known aliases to canonical keys', () => {
      const transform = createHeaderTransformer(USER_DELETE_ALIASES);
      assert.strictEqual(transform('User Name'), 'userName');
      assert.strictEqual(transform('user name'), 'userName');
      assert.strictEqual(transform('username'), 'userName');
      assert.strictEqual(transform('user_name'), 'userName');
      assert.strictEqual(transform('Email'), 'userName');
      assert.strictEqual(transform('User ID'), 'userName');
    });

    it('preserves unknown headers trimmed', () => {
      const transform = createHeaderTransformer(USER_SET_FIELD_ALIASES);
      assert.strictEqual(transform('  User ID  '), 'userId');
      assert.strictEqual(transform('  First Name  '), 'First Name');
      assert.strictEqual(transform('Custom_Field_1'), 'Custom_Field_1');
    });
  });

  describe('parseCsv with command schemas', () => {
    it('parses budgetitems delete with permissive headers', () => {
      const csv = `Portal ID,Item ID,Project Name,Account Code\n100,200,Sample Project,AC-01`;
      const result = parseCsv<{
        portalId: string;
        itemId: string;
        projectName?: string;
        accountCode?: string;
      }>(csv, BUDGET_ITEM_DELETE_ALIASES);

      assert.strictEqual(result.errors.length, 0);
      assert.strictEqual(result.data.length, 1);
      assert.deepStrictEqual(result.data[0], {
        portalId: '100',
        itemId: '200',
        projectName: 'Sample Project',
        accountCode: 'AC-01',
      });
    });

    it('parses budgetitems delete with project name and line item without IDs', () => {
      const csv = `Project,Line Item\nSample Project,01-100-200`;
      const result = parseCsv<{
        portalId?: string;
        itemId?: string;
        projectName?: string;
        accountCode?: string;
      }>(csv, BUDGET_ITEM_DELETE_ALIASES);

      assert.strictEqual(result.errors.length, 0);
      assert.strictEqual(result.data.length, 1);
      assert.deepStrictEqual(result.data[0], {
        projectName: 'Sample Project',
        accountCode: '01-100-200',
      });
    });

    it('parses budgetitems set with project name and line item without IDs', () => {
      const csv = `Project Name,Line Item,Allow Charges,Description\nSample Project,01-100-200,true,Test Update`;
      const result = parseCsv<{
        projectName?: string;
        accountCode?: string;
        allowCharges?: string;
        description?: string;
      }>(csv, BUDGET_ITEM_SET_ALIASES);

      assert.strictEqual(result.errors.length, 0);
      assert.strictEqual(result.data.length, 1);
      assert.deepStrictEqual(result.data[0], {
        projectName: 'Sample Project',
        accountCode: '01-100-200',
        allowCharges: 'true',
        description: 'Test Update',
      });
    });

    it('parses budgetitems set with permissive headers', () => {
      const csv = `Project ID,Budget Item ID,Allow Charges,Approval Required For Change,Description\n100,200,true,false,Test Item`;
      const result = parseCsv<{
        portalId: string;
        itemId: string;
        allowCharges?: string;
        approvalRequiredForChange?: string;
        description?: string;
      }>(csv, BUDGET_ITEM_SET_ALIASES);

      assert.strictEqual(result.errors.length, 0);
      assert.strictEqual(result.data.length, 1);
      assert.deepStrictEqual(result.data[0], {
        portalId: '100',
        itemId: '200',
        allowCharges: 'true',
        approvalRequiredForChange: 'false',
        description: 'Test Item',
      });
    });

    it('parses users delete with permissive headers', () => {
      const variations = [
        'User Name\njohn.doe@example.com',
        'user name\njohn.doe@example.com',
        'username\njohn.doe@example.com',
        'user_name\njohn.doe@example.com',
        'email\njohn.doe@example.com',
      ];

      for (const csv of variations) {
        const result = parseCsv<{ userName: string }>(csv, USER_DELETE_ALIASES);
        assert.strictEqual(result.errors.length, 0);
        assert.strictEqual(result.data.length, 1);
        assert.strictEqual(result.data[0]?.userName, 'john.doe@example.com');
      }
    });

    it('parses users remove-project-role with permissive headers', () => {
      const csv = `Project Name,Role Name,User Name\nProject Alpha,Admin,jane.doe`;
      const result = parseCsv<{
        projectName: string;
        roleName: string;
        userName: string;
      }>(csv, USER_REMOVE_PROJECT_ROLE_ALIASES);

      assert.strictEqual(result.errors.length, 0);
      assert.strictEqual(result.data.length, 1);
      assert.deepStrictEqual(result.data[0], {
        projectName: 'Project Alpha',
        roleName: 'Admin',
        userName: 'jane.doe',
      });
    });

    it('parses users remove-project with permissive headers', () => {
      const csv = `Project,Username\nProject Beta,jane.doe`;
      const result = parseCsv<{
        projectName: string;
        userName: string;
      }>(csv, USER_REMOVE_PROJECT_ALIASES);

      assert.strictEqual(result.errors.length, 0);
      assert.strictEqual(result.data.length, 1);
      assert.deepStrictEqual(result.data[0], {
        projectName: 'Project Beta',
        userName: 'jane.doe',
      });
    });

    it('parses users setsso with permissive headers', () => {
      const variations = [
        'User ID,Single Sign-On\n12345,true',
        'username,sso_enabled\njohn.doe,yes',
        'user_id,require sso\n99999,false',
      ];

      for (const csv of variations) {
        const result = parseCsv<{ userId: string; sso: string }>(csv, USER_SET_SSO_ALIASES);
        assert.strictEqual(result.errors.length, 0);
        assert.strictEqual(result.data.length, 1);
        assert.ok(result.data[0]?.userId);
        assert.ok(result.data[0]?.sso);
      }
    });

    it('parses users setfield with userId mapped and field labels preserved', () => {
      const csv = `User ID,First Name,Last Name,Custom Division\n12345,Alice,Smith,Finance`;
      const result = parseCsv<Record<string, string>>(csv, USER_SET_FIELD_ALIASES);

      assert.strictEqual(result.errors.length, 0);
      assert.strictEqual(result.data.length, 1);
      assert.deepStrictEqual(result.data[0], {
        userId: '12345',
        'First Name': 'Alice',
        'Last Name': 'Smith',
        'Custom Division': 'Finance',
      });
    });

    it('parses CSV without aliasMap preserving trimmed header names', () => {
      const csv = ` Col A , Col B \nval1,val2`;
      const result = parseCsv<Record<string, string>>(csv);

      assert.strictEqual(result.errors.length, 0);
      assert.strictEqual(result.data.length, 1);
      assert.strictEqual(result.data[0]?.['Col A'], 'val1');
      assert.strictEqual(result.data[0]?.['Col B'], 'val2');
    });

    it('handles empty CSV input cleanly', () => {
      const result = parseCsv('');
      assert.strictEqual(result.data.length, 0);
      assert.strictEqual(result.errors.length, 0);
    });

    it('filters out UndetectableDelimiter warnings on single column files', () => {
      const csv = `username\nuser1@example.com\nuser2@example.com`;
      const result = parseCsv<{ username: string }>(csv);
      assert.strictEqual(result.errors.length, 0);
      assert.strictEqual(result.data.length, 2);
    });
  });
});
