const sellersprite = require('./sites/sellersprite');
const amazon = require('./sites/amazon');

const registry = new Map([
  ['sellersprite', {
    name: 'sellersprite',
    displayName: '卖家精灵',
    adapter: sellersprite,
    status: 'implemented'
  }],
  ['amazon', {
    name: 'amazon',
    displayName: '亚马逊',
    adapter: amazon,
    status: 'implemented'
  }]
]);

function getSite(name) {
  const normalized = String(name || 'sellersprite').trim().toLowerCase();
  return registry.get(normalized);
}

function listSites() {
  return Array.from(registry.values()).map(site => ({
    name: site.name,
    displayName: site.displayName,
    status: site.status
  }));
}

module.exports = {
  getSite,
  listSites
};
