# Feature: Prepare payment details
## 1. User goal
As a pet owner, I want to review the selected pet service and its amount before payment.

## 2. Scope
Review selected service and amount before payment.
The service catalogue is in section 4.

Use the server catalogue price. Do not accept a client-supplied payment amount.

## 3. Request
GET /payments/prepare/:serviceId

## 4. Service catalogue
This is the only catalogue listing. Service names are returned exactly as written here.

id, service name, price
1, Vaccination, 35
2, Pet Grooming, 50
3, Boarding, 80

## 5. Successful response
Every HTTP 200 response is a JSON object with exactly these five top-level properties:
serviceId (number), serviceName (string), amount (number),
currency (string, "sgd"), status (string, "READY_FOR_PAYMENT").

serviceId is the requested catalogue ID, returned as a JSON number (for example 1, not "1").

## 6. Unsuccessful response
Unknown service: HTTP 404 with {"error":"Service not found"}.

## 7. Acceptance criteria
AC1: GET /payments/prepare/1 returns HTTP 200 with serviceId 1, serviceName Vaccination, amount 35, currency "sgd" and status "READY_FOR_PAYMENT".
AC2: GET /payments/prepare/2 returns HTTP 200 with serviceId 2, serviceName Pet Grooming, amount 50, currency "sgd" and status "READY_FOR_PAYMENT".
AC3: GET /payments/prepare/3 returns HTTP 200 with serviceId 3, serviceName Boarding, amount 80, currency "sgd" and status "READY_FOR_PAYMENT".
AC4: GET /payments/prepare/999 returns HTTP 404 with the exact error object {"error":"Service not found"}.
AC5: Every HTTP 200 response has exactly the five agreed top-level properties,
correct types, catalogue values, "sgd" and "READY_FOR_PAYMENT".
Access: No login required for this classroom mock.
Out of scope: charging money, gateway integration, transactions,
new database tables, EJS pages or changes to existing features.


## 8. Open questions
- Should a non-numeric or otherwise non-catalogue path value (for example /payments/prepare/abc) be treated as "Unknown service" (404), or is its behaviour intentionally unspecified? Not agreed yet.
- Should the spec define responses for failures other than an unknown service, or limit its failure contract to that case only? Not agreed yet.
