async function test() {
  try {
    const res = await fetch(
      'http://localhost:4000/trpc/feed.list?input={}',
    ).then((r) => r.json());
    const items = res.result.data.items;
    console.log('Feeds:', items);

    if (items.length > 0) {
      const mpId = items[0].id;
      console.log('Fetching articles for mpId:', mpId);

      const res2 = await fetch(
        'http://localhost:4000/trpc/platform.getMpArticles',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mpId }),
        },
      ).then((r) => r.json());

      console.log('Articles Response:', JSON.stringify(res2, null, 2));
    }
  } catch (err) {
    console.error(err);
  }
}
test();
