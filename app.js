const sql = require('mssql')
const { chromium } = require('playwright-core');
require('dotenv').config()
const express = require('express');
const app = express();
const http = require('http');
const cors = require('cors');
const { EmailClient } = require("@azure/communication-email");
const bodyParser = require('body-parser');
const fs = require('fs');
const server = http.Server(app);
const port = process.env.PORT || 8888;
const emailClient = new EmailClient(process.env.MAIL_CONNECTION_STRING);
const pool = new sql.ConnectionPool(process.env.CONNECTION_STRING);
const email_template = fs.readFileSync('email-template.html').toString();
const trip_template = fs.readFileSync('trip-template.html').toString();
const Currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

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

function processDate(dateString){
    var parsedDate = new Date(dateString);
    parsedDate.setFullYear(new Date().getFullYear());
    parsedDate.setDate(parsedDate.getDate() + 1);

    if(parsedDate < new Date()){
        parsedDate.setFullYear(parsedDate.getFullYear() + 1)
    }

    return parsedDate;
}

app.post('/', async (req, res) => {

    const request = await getRequest();
    request.input('to', sql.VarChar, req.body.to)
    request.input('from', sql.VarChar, req.body.from)
    request.input('departure', sql.Date, processDate(req.body.departure))
    request.input('return', sql.Date, processDate(req.body.return))
    request.input('price', sql.Decimal, req.body.price)
    request.input('name', sql.VarChar, req.body.name)
    await request.query(`insert into Trips
    (toLocation, fromLocation, departureDate, returnDate, tripStatus, price, tripName) values
    (@to, @from, @departure, @return, 0, @price, @name)`
    ,(err, result) => {
        res.status(200).send("wow good trip");
        if(err) console.dir(err)
    })

});

app.get('/check', async (req, res) => {
    try{
        await checkFlights();
        res.status(200).send("check complete");
    }catch(e){
        console.log("Error", e.stack);
        console.log("Error", e.name);
        console.log("Error", e.message);
        res.status(500).send(e);
    }
});

app.delete("/", async (req, res) => {
    
    const request = await getRequest();
    request.input('id', sql.Int, req.body.id)

    await request.query(`delete from Trips where id = @id`
    ,(err, result) => {
        res.status(200).send("trip removed");
        if(err) console.dir(err)
    })
});

//TODO Edit

server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}/`);
});

async function getRequest(){

    if(!pool.connected){
        await pool.connect();
    }

    return new sql.Request(pool);
}

async function getTrips() {

    try {
        return (await (await getRequest()).query(`select * from Trips`)).recordset;
    } catch (err) {
        return err
    }

}

async function checkFlights(){
    console.log("Checking . . .")

    const request = await getRequest();
    request.input('date', sql.Date, new Date())
    await request.query(`delete from Trips where departureDate < @date`,
        (err, result) => { if (err) console.dir(err) });

    console.log("Filtered existing trips, getting trip list");

    var trips = await getTrips();

    console.log("Recieved trips, populating flight list");

    var results = [];

    await Promise.all(trips.map(async trip => {
        var flights = await getFlights(trip);

        results.push(...flights.filter(t => t.price < trip.price));
    }));


    if(results.length){
        console.log(`Checking complete, ${results.length} potential flights found.  Sending email . . .`);

        var emailString = results.reduce(
            (a, r) => a += trip_template
                .replace("{{from}}", r.from)
                .replace("{{to}}", r.to)
                .replace("{{departure}}", r.departureDate.toLocaleDateString('en-US'))
                .replace("{{return}}", r.returnDate.toLocaleDateString('en-US'))
                .replace("{{price}}", Currency.format(r.price))
                .replace("{{name}}", r.name ? r.name : "")
                .replace("{{description}}", r.description),
            "",
        );

        const emailMessage = {
            senderAddress: "trip-check@itgtrips.com",
            content: {
                subject: "Trip Check Results",
                html: email_template.replace("{{flights}}", emailString),
            },
            recipients: {
                to: [{ address: process.env.TO_EMAIL_ADDRESS }],
            },
        };
    
        const poller = await emailClient.beginSend(emailMessage);
        await poller.pollUntilDone();

        console.log(`Email sent`);

    }else{
        console.log("No results found.")
    }

}

async function getFlights(options){
	var flightInfoList = [];

	const browser = await chromium.connect(
        `wss://eastus.api.playwright.microsoft.com/api/authorize/connectSession?cap=${JSON.stringify({
            os: 'windows',
            runId: new Date().toISOString()
          })}`,
        { 
            timeout: 30000,
            headers: {
              'x-mpt-access-key': process.env.PLAYWRIGHT_SERVICE_ACCESS_TOKEN
            },
            exposeNetwork: '<loopback>'
        }
    );

	const page = await browser.newPage();
	try {
		await page.goto('https://www.google.com/travel/flights');
		await page.getByLabel('1 passenger, change number of').click({delay : 100});
		await page.getByLabel('Add adult').click({
		  clickCount: 6,
		  delay : 100
		});
		await page.getByRole('button', { name: 'Done' }).click({delay : 100});
        await page.keyboard.press('Tab', {delay : 100});
        await page.keyboard.press('Tab', {delay : 100});
		await page.keyboard.type(options.fromLocation, {delay : 100});
		await page.keyboard.press('Enter', {delay : 100});
		await page.keyboard.press('Tab', {delay : 100});
		await page.keyboard.type(options.toLocation, {delay : 100});
		await page.getByRole('combobox', { name: 'Where else?' }).press('Enter', {delay : 100});
		await page.keyboard.press('Tab', {delay : 100});
		await page.getByRole('textbox', { name: 'Departure' }).fill(options.departureDate.toLocaleDateString('en-US'));
		await page.keyboard.press('Tab', {delay : 100});
		await page.getByRole('textbox', { name: 'Return' }).fill(options.returnDate.toLocaleDateString('en-US'));
		await page.keyboard.press('Tab', {delay : 100});
		await page.keyboard.press('Enter', {delay : 100});
        await page.waitForSelector('.pIav2d');
        await page.waitForTimeout(900);
		await page.getByLabel('Best Flights, Change sort').click({delay : 100});
		await page.getByLabel('Select your sort order.').getByText('Price').click({delay : 100});
        await page.waitForTimeout(1000);
		
		var flightInfoList = await page.$$eval('.pIav2d', items =>
			items.map(item => ({
				description:item.querySelector('.JMc5Xc').ariaLabel.trim().replace(" Select flight", ""), 
				airline: item.querySelector('.sSHqwe').textContent.trim(),
				travelTime: item.querySelector('.gvkrdb').textContent.trim(),
				price: parseFloat(item
                    .querySelector('.YMlIz.FpEdX')
                    .children[0].textContent
                    .trim().replace("$", "").replace(",", "")) / 7
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
        name: options.tripName
    }));
};