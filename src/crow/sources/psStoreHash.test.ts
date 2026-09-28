import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bundleDefinitions, queryHash } from './psStoreHash';

/** A bundle as the store's client builds it: `gql` templates as arrays of their strings */
const bundle = (query: string, fragment: string) =>
  `var U=(0,Z.Ps)(p||(r=[${JSON.stringify(query)},"\\n"],r)),F=(0,Z.Ps)(f||(f=[${JSON.stringify(fragment)}]));`;

const QUERY = `
  query categoryGridRetrieve($pageArgs: PageArgs, $id: ID!) {
    categoryGridRetrieve(pageArgs: $pageArgs, id: $id) { id products { ...productFields } }
  }`;
const FRAGMENT = 'fragment productFields on Product { name id }';

describe('the hash of a PS Store query', () => {
  it('finds the operations and the fragments of the bundles', () => {
    const definitions = bundleDefinitions([bundle(QUERY, FRAGMENT), 'var x = ["not a query"];']);
    assert.deepEqual([...definitions.keys()], ['categoryGridRetrieve', 'productFields']);
  });

  it('hashes the document sorted, so the order the client wrote it in does not matter', () => {
    const hash = queryHash(bundleDefinitions([bundle(QUERY, FRAGMENT)]), 'categoryGridRetrieve');
    assert.match(hash ?? '', /^[0-9a-f]{64}$/);
    const reordered = QUERY.replace('$pageArgs: PageArgs, $id: ID!', '$id: ID!, $pageArgs: PageArgs').replace('pageArgs: $pageArgs, id: $id', 'id: $id, pageArgs: $pageArgs');
    assert.equal(queryHash(bundleDefinitions([bundle(reordered, 'fragment productFields on Product { id name }')]), 'categoryGridRetrieve'), hash);
    const other = queryHash(bundleDefinitions([bundle(QUERY, 'fragment productFields on Product { name id price }')]), 'categoryGridRetrieve');
    assert.notEqual(other, hash, 'another selection is another query');
  });

  it('has none for an operation the bundles lack, or one whose fragment they miss', () => {
    assert.equal(queryHash(bundleDefinitions([bundle(QUERY, FRAGMENT)]), 'productRetrieve'), null);
    assert.equal(queryHash(bundleDefinitions([bundle(QUERY, 'fragment otherFields on Product { id }')]), 'categoryGridRetrieve'), null);
  });
});
