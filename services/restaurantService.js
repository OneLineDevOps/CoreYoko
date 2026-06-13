let restaurants = [
  { id: 1, name: 'Demo Restaurant', cuisine: 'Global' }
];
let nextId = 2;

function getAll() {
  return restaurants;
}

function getById(id) {
  const nid = Number(id);
  return restaurants.find(r => r.id === nid);
}

function create(data) {
  const r = { id: nextId++, ...data };
  restaurants.push(r);
  return r;
}

module.exports = { getAll, getById, create };
