/**
 * ### SPV Event Server (SSE)
 * 
 * example apache vhost
 * ProxyPass /sse http://domain:port number/
 * ProxyPassReverse /sse http://domain:port number/
 * 
 * [example test]
 * command: $ node spv.sse.v1.js
 * command: $ pm2 delete pjt-name-sse
 * command: $ pm2 show pjt-name-sse
 * [example production]
 * command: $ pm2 list
 * command: $ pm2 restart pjt-name-sse
 * command other: $ pm2 restart spv.sse.v1.js --name pjt-name-sse
 * 
**/

const config = require('config');
const SSE = require('sse');// SSEします
const http = require('http');// サーバなので
const url = require('url');// URL判断
const mysql = require('mysql');// example mysql
const cookie = require('cookie');// 
const unserializer = require('php-session-unserialize');// SSE以外はPHPを使った場合
const fetch = require('node-fetch');// use spv api
//const moment = require("moment");// 時刻変更を使うなら
const { base64encode, base64decode } = require('nodejs-base64');// must base64
const util = require('util');// 

var pool  = mysql.createPool({
	connectionLimit : config.db.connectionLimit,
	host            : config.db.host,
	user            : config.db.user,
	password        : config.db.password,
	database        : config.db.database
});

// near php isset()
function isset( data ){
	return ( typeof( data ) != 'undefined' );
}

http.createServer(async function(req, res) {
	var url_parse = url.parse(req.url, true);
	console.log("url : " + url_parse.pathname);
	console.log("channel_id: " + url_parse.query.ch);//example: http...?ch=channel_id

	//channel_idがあれば（なければ終了...）
	if(isset(url_parse.query.ch)) {
		// Open a long held http connection
		res.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			'Connection': 'keep-alive',
			//'Access-Control-Allow-Origin': '*',
			//'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept'
		});

		// Send data to the client
		var cmt_id = 0;
		var row = [];
		const sleep = msec => new Promise(resolve => setTimeout(resolve, msec));

		//PHPのセッションを取得 デフォならPHPSESSIDというクッキーがブラウザにある
		const PHPSESSID = cookie.parse(req.headers.cookie).PHPSESSID;

		//なければログアウトしているので何もしない。(PHPのチャット画面はそもそもログイン画面に遷移する仕組み)
		if(!PHPSESSID) {
			res.write("data: not login\n\n");
			res.end();
		}

		//sessionsTBLのdata.idからlogin.idを特定する
		pool.getConnection(async (err, connection) => {
			if (err) throw err;

			//console.log('select `data` from `sessions` where sessid = "' + PHPSESSID + '"');
			//php session tableのネットに落ちている定番なテーブル構成です。
            await connection.query('select `data` from `sessions` where sessid = "' + PHPSESSID + '"', async function (error, results1, fields) {
				if (error) throw error;

				const obj = unserializer(results1[0].data);
				//console.log('data.login.id is: ', obj.login.id);
				//console.log('data.login.layer is: ', obj.login.layer);

				//レイヤー2がお店、レイヤー3がお客さんです。ログインしている場合セッションから取得ができます
                //チャンネルを取得。取得できなければ不具合または不正アクセス
				//L*_statusが非表示でも関係なく実施される
				let add_where = "";
				let add_select = "";
				if(obj.login.layer == 2) {
					const l2_id = obj.login.client_id;
					add_where += " and l2_id = '" + l2_id + "'";
					add_select = "l2_token";
				} else if (obj.login.layer == 3) {
					const l3_id = obj.login.user_id;
					add_where += " and l3_id = '" + l3_id + "'";
					add_select = "l3_token";
				} else if(obj.login.layer != 1) {
					//レイヤーが不明なら処理終了
					res.write("data: not data\n\n");
					res.end();
				}

				await connection.query('select `ch`, `' + add_select + '` as token  from `chat` where `ch` = "' + url_parse.query.ch + '" and status = "on"' + add_where, async function (error, results2, fields) {
					connection.release();
					if (error) throw error;

					//レコードがなければ不正なので終了
					if(!isset(results2[0])) {
						res.write("data: not data\n\n");
						res.end();
					}

					//console.log('data.chat.ch is: ', results2[0].ch);
					//console.log('data.chat.token is: ', results2[0].token);
					//console.log('https://hack.spvchannels.io/api/v1/channel/'+results2[0].ch+'?unread=true');

					//SPVのチャンネルから未読メッセージリストを取得する
					var broadcast = async function() {
						console.log("start: broadcast token::"+results2[0].token);
						//console.log('data.chat.ch is: ', results2[0].ch);
						//console.log('data.chat.token is: ', results2[0].token);
						//console.log('https://hack.spvchannels.io/api/v1/channel/'+results2[0].ch+'?unread=true');

						//SPVのチャンネルから未読メッセージリストを取得する
						(async () => {
							try {
								//console.log('broadcast message list: https://hack.spvchannels.io/api/v1/channel/'+results2[0].ch+'?unread=true');
								fetch('https://hack.spvchannels.io/api/v1/channel/'+results2[0].ch+'?unread=true', {
									headers: {
										'accept': 'text/plain',
										'Content-Type': 'application/json',
										'Authorization': 'Bearer ' + results2[0].token
									}
								})
								.then(res => res.json())
								.then(spv_res => {
									if(spv_res) {
										//console.log(spv_res);
										let sid = 0;
										let itemsProcessed = 0;
										spv_res.forEach( async (rec, index, array) => {
											await sleep(50);//書き込みと通信到達に僅かでも差を設けないと場合により順番がズレる時がある...かも？過去の経験で今回は見てない

											//console.log("sequence: " + rec.sequence);
											//console.log("received: " + moment(rec.received).add(-9, 'h').format('MM/DD HH:mm'));
											console.log("payload: " + base64decode(rec.payload));
											if(sid < rec.sequence)sid = rec.sequence//シーケンスDの最後を知りたい

											let json = JSON.stringify({ s: rec.sequence, text: base64decode(rec.payload), date: moment(rec.received).format('MM/DD HH:mm') });//.add(9, 'h') YYYY/MM/DD HH:mm:ss
											res.write("data: " + json + "\n\n");
											res.flushHeaders();

											itemsProcessed++;
											//console.log("num: " + itemsProcessed);
										});
									}
								});
							} catch (error) {
								console.log(error);
							}
						})();
					}
					//APIを叩きすぎると迷惑かもしれないので、5秒のインターバルを設定している。
                    //また50回の処理でSSEを切断している。
                    //それを検知してブラウザ側ではリロードしてもらっている。
                    //代わりにブラウザ側に定期的に問い合わせさせるなどの処理を入れていない
					var cnt = 0;
					var setTimer = setInterval(function(){
						cnt++
						console.log("loop count :: "+cnt);
						if(cnt <= 50)
							broadcast()
						else {
							clearInterval(setTimer);
							res.end();
						}
					}, 5000)
				});
			});
		});
	}
}).listen(config.db.port);