const sql = require('mssql')
const { chromium } = require('playwright');
require('dotenv').config()
const express = require('express');
var cors = require('cors');
const cron = require('node-cron');
const { EmailClient } = require("@azure/communication-email");
const app = express();
const http = require('http');
var bodyParser = require('body-parser')
const server = http.Server(app);
const port = process.env.PORT || 8888;
const emailClient = new EmailClient(process.env.MAIL_CONNECTION_STRING);
fs = require('fs');
const email_template = fs.readFileSync('email-template.html').toString();
const trip_template = fs.readFileSync('trip-template.html').toString();

app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: false }))
app.use(cors());
app.use(express.json())
app.use(function(req, res, next) {
    if (req.headers.authorization != process.env.PASSWORD_STRING) {
        res.status(403).json({ error: 'FORBIDDEN' });
    }else{
        next();
    }
});
  
app.get('/', async (req, res) => {
    res.send(await getTrips());
});

app.post('/', async (req, res) => {

    var depDate = new Date(req.body.departure);
    if(depDate < new Date()){
        depDate.setFullYear(depDate.getFullYear() + 1)
    }

    var retDate = new Date(req.body.return);
    if(retDate < new Date()){
        retDate.setFullYear(retDate.getFullYear() + 1)
    }

    await sql.connect(process.env.CONNECTION_STRING)
    const request = new sql.Request()
    request.input('to', sql.VarChar, req.body.to)
    request.input('from', sql.VarChar, req.body.from)
    request.input('departure', sql.Date, depDate)
    request.input('return', sql.Date, retDate)
    request.input('price', sql.Decimal, req.body.price)
    request.query(`insert into Trips
    (toLocation, fromLocation, departureDate, returnDate, tripStatus, price) values
    (@to, @from, @departure, @return, 0, @price)`

    ,(err, result) => {
        console.dir(result)
        console.dir(err)
    })
    res.status(200).send("wow good trip");
});

//Remove
app.delete("/", (req, res) => {
    const request = new sql.Request()
    request.input('id', sql.Int, req.param.id)
    request.query(`delete from Trips where id = @id`
    ,(err, result) => {
        console.dir(result)
        console.dir(err)
    })
});

//TODO Edit

//Daily check
cron.schedule('* * * * *', async () => {
    console.log("Checking . . .")

    await sql.connect(process.env.CONNECTION_STRING)
    const request = new sql.Request()
    request.input('date', sql.Date, new Date())
    await request.query(`delete from Trips where departureDate < @date`
    ,(err, result) => {
        console.dir(result)
        console.dir(err)
    })

    var trips = await getTrips();

    var results = [];

    await Promise.all(trips.map(async trip => {
        var flights = await getFlights(trip);

        //results.push(
        //    ...flights.filter(t => parseFloat(t.price.replace("$", "").replace(",", "")) / 7 < trip.price));
    }));


    if(results.length){
        console.log(`Checking complete, ${results.length} potential flights found.  Sending email . . .`);

        var emailString = results.reduce(
            (a, r) => a += trip_template
                .replace("{{from}}", r.from)
                .replace("{{to}}", r.to)
                .replace("{{departure}}", new Date(r.departureDate).toLocaleDateString('en-US'))
                .replace("{{return}}", new Date(r.returnDate).toLocaleDateString('en-US'))
                .replace("{{price}}", r.price)
                .replace("{{description}}", r.description),
            "",
        );

        const emailMessage = {
            senderAddress: "DoNotReply@566b52af-1f5a-4736-8532-0f99329e9235.azurecomm.net",
            content: {
                subject: "Wander Watch",
                html: email_template.replace("{{flights}}", emailString),
            },
            recipients: {
                to: [{ address: "karjaxthevaliant@gmail.com" }],
            },
        };
    
        const poller = await emailClient.beginSend(emailMessage);
        await poller.pollUntilDone();

        console.log(`Email sent`);

    }else{
        console.log("No results found.")
    }

    
});

server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}/`);
});

async function getTrips() {
    try {
        await sql.connect(process.env.CONNECTION_STRING)
        return (await sql.query(`select * from Trips`)).recordset
    } catch (err) {
        return err
    }
}

async function getFlights(options){
	var flightInfoList = [];

	const browser = await chromium.launch();
	const page = await browser.newPage();
	try {
		await page.goto('https://www.google.com/travel/flights');
		await page.getByLabel('1 passenger, change number of').click({delay : 100});
		await page.getByLabel('Add adult').click({
		  clickCount: 6,
		  delay : 100
		});
		await page.getByRole('button', { name: 'Done' }).click({delay : 100});
		await page.getByLabel('Where from? Minneapolis').click({delay : 100});
		await page.getByRole('combobox', { name: 'Where else?' }).fill(options.fromLocation);
		await page.getByRole('combobox', { name: 'Where else?' }).press('Enter', {delay : 100});
		await page.keyboard.press('Tab', {delay : 100});
		await page.keyboard.type(options.toLocation, {delay : 100})
		await page.getByRole('combobox', { name: 'Where else?' }).press('Enter', {delay : 100});
		await page.keyboard.press('Tab', {delay : 100});
		await page.getByRole('textbox', { name: 'Departure' }).fill(options.departureDate.toString());
		await page.keyboard.press('Tab', {delay : 100});
		await page.getByRole('textbox', { name: 'Return' }).fill(options.returnDate.toString());
		await page.keyboard.press('Tab', {delay : 100});
		await page.keyboard.press('Enter', {delay : 1000});
		await page.waitForSelector('.pIav2d');
		
		var flightInfoList = await page.$$eval('.pIav2d', items =>
			items.map(item => ({
				description:item.querySelector('.JMc5Xc').ariaLabel.trim().replace(" Select flight", ""), 
				airline: item.querySelector('.sSHqwe').textContent.trim(),
				travelTime: item.querySelector('.gvkrdb').textContent.trim(),
				price: item.querySelector('.YMlIz.FpEdX').children[0].textContent.trim()
			}))
		);
	} catch (error) {
		console.log(error)
	} finally {
		await browser.close();
	}

	return flightInfoList.map(f => ({
        ...f,
        from: options.fromLocation,
        to: options.toLocation,
        departureDate: options.departureDate,
        returnDate: options.returnDate,
    }));
};