const got = require('./apps/server/node_modules/got');

async function main() {
  const imageUrl = 'https://mmbiz.qpic.cn/mmbiz_png/ga8QSQV1S8NBlz1pDn5RgSklw/0?wx_fmt=png'; // Example image URL from same feed
  
  console.log('Testing image fetch:', imageUrl);
  try {
    const res = await got(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.4951.64 Safari/537.36'
      },
      responseType: 'buffer',
      timeout: 5000
    });
    console.log('Success! Image size:', res.body.length);
    console.log('Content-Type:', res.headers['content-type']);
  } catch (err) {
    console.error('Failed to fetch image:', err.message);
    if (err.response) {
      console.log('Status:', err.response.statusCode);
      console.log('Headers:', JSON.stringify(err.response.headers, null, 2));
    }
  }
}

main();
